import asyncio

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

_is_sqlite = settings.database_url.startswith("sqlite")

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
    pool_pre_ping=True,
    # Larger pool (2026-06-21): the availability/runner DB phases now run in
    # worker threads (via asyncio.to_thread) so their synchronous commits
    # don't block the event loop during a large run. Each threaded phase
    # checks out a connection, so a 50-wide run + FE polling can want
    # dozens at once; the old 5+10 default starved and serialized them.
    # SQLite connections are cheap, and `check_same_thread=False` already
    # permits cross-thread use (each thread still uses its own session).
    pool_size=20,
    max_overflow=30,
)

if _is_sqlite:
    # Enable WAL mode on every new SQLite connection. Default is the
    # rollback journal, which serializes ALL access (writers block
    # readers). WAL lets readers proceed concurrently with a writer —
    # crucial for the LAN deploy where 2-5 users hit the API at once.
    # Also enable `synchronous=NORMAL` (vs FULL): durability tradeoff
    # that's safe with WAL — survives app crash, may lose the last few
    # writes on power loss, which we accept for the throughput win.
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _conn_record):
        cur = dbapi_conn.cursor()
        try:
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            # 5-second timeout for write contention — gives long writers
            # a chance to finish before the reader gives up with
            # "database is locked".
            cur.execute("PRAGMA busy_timeout=5000")
        finally:
            cur.close()

    # Busy timeout per checkout, by thread (2026-10-31). On the event-loop
    # thread, waiting out the write lock freezes every request, so keep the
    # 5 s cap there. Worker threads (asyncio.to_thread offloads, threadpool
    # endpoints) block nothing while they wait, so give them 30 s: with the
    # runners and retry path offloaded, dozens of threads queue for SQLite's
    # one writer, and at 5 s some gave up with "database is locked" — a
    # synthetic 1,000-domain Wayback retry pass under a competing writer
    # dropped 18-25 retries, some after their fetch, leaving the CR row
    # half-updated. The same error failed run 186 on 2026-10-27.
    LOOP_BUSY_TIMEOUT_MS = 5_000
    THREAD_BUSY_TIMEOUT_MS = 30_000

    @event.listens_for(engine, "checkout")
    def _sqlite_busy_timeout(dbapi_conn, _conn_record, _conn_proxy):
        try:
            asyncio.get_running_loop()
            ms = LOOP_BUSY_TIMEOUT_MS
        except RuntimeError:
            ms = THREAD_BUSY_TIMEOUT_MS
        cur = dbapi_conn.cursor()
        try:
            cur.execute(f"PRAGMA busy_timeout={ms}")
        finally:
            cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
