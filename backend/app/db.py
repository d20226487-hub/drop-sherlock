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

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
