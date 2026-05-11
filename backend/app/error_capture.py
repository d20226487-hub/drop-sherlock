"""Phase 2 error capture.

Two write paths feed `error_log`:

1. `DbLogHandler` — a logging.Handler attached to the root logger.
   Catches every `log.exception(...)` and `log.error(...)` from anywhere
   in the codebase (provider clients, runner, routers). Carries the
   formatted traceback when present.

2. `db_exception_middleware` — wraps every FastAPI request. On any
   uncaught exception inside a handler, persist the traceback before
   re-raising so FastAPI's default 500 response still goes out. The user
   sees their HTTP error AND we have a record afterward.

Both paths are best-effort: if persistence itself raises (db gone,
encoding issue), they swallow it silently rather than masking the original
error. The whole point is "free, drop-in capture" — making the capture
itself a failure mode would be self-defeating."""
from __future__ import annotations

import json
import logging
import traceback as tb_mod
from datetime import datetime

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from .db import SessionLocal
from .models import ErrorLog


# Log records emitted by these loggers are already noisy and rarely
# actionable — uvicorn's access log, sqlalchemy engine echos, httpx wire
# logs. Skip them at the handler so error_log stays signal-only.
_NOISY_LOGGER_PREFIXES = (
    "uvicorn.access",
    "sqlalchemy",
    "httpx",
    "httpcore",
)


def _persist(
    *,
    source: str,
    level: str,
    message: str,
    traceback: str,
    context: dict | None = None,
) -> None:
    db = SessionLocal()
    try:
        row = ErrorLog(
            created_at=datetime.utcnow(),
            source=source,
            level=level,
            message=message[:8192],  # keep DB rows reasonable
            traceback=traceback[:32_768] if traceback else "",
            context_json=json.dumps(context, ensure_ascii=False)
            if context
            else "",
        )
        db.add(row)
        db.commit()
    except Exception:  # noqa: BLE001
        # Capture must never crash the caller. Drop the record silently;
        # the original error/log line still went to stderr via uvicorn's
        # default handler.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


class DbLogHandler(logging.Handler):
    """Persist every error/critical log record into `error_log`."""

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.ERROR:
            return
        for pfx in _NOISY_LOGGER_PREFIXES:
            if record.name.startswith(pfx):
                return
        # Render message + traceback the same way the default formatter
        # does, so what users see in the table matches what they'd see in
        # docker logs.
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001
            message = repr(record.msg)
        traceback = ""
        if record.exc_info:
            try:
                traceback = "".join(tb_mod.format_exception(*record.exc_info))
            except Exception:  # noqa: BLE001
                traceback = ""
        _persist(
            source="backend_log",
            level=record.levelname.lower(),
            message=f"{record.name}: {message}",
            traceback=traceback,
            context={
                "logger": record.name,
                "module": record.module,
                "func": record.funcName,
            },
        )


def install_db_log_handler() -> None:
    """Attach a single instance of DbLogHandler to the root logger.
    Idempotent — safe to call multiple times in dev/reload scenarios."""
    root = logging.getLogger()
    for h in root.handlers:
        if isinstance(h, DbLogHandler):
            return
    h = DbLogHandler()
    h.setLevel(logging.ERROR)
    root.addHandler(h)


class DbExceptionMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware that persists uncaught exceptions raised by
    request handlers. Re-raises after persisting so the normal 500 response
    pipeline still runs (FastAPI returns its own JSON error body)."""

    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:  # noqa: BLE001
            try:
                tb = "".join(
                    tb_mod.format_exception(type(exc), exc, exc.__traceback__)
                )
                _persist(
                    source="backend_exception",
                    level="error",
                    message=f"{type(exc).__name__}: {exc}",
                    traceback=tb,
                    context={
                        "method": request.method,
                        "path": request.url.path,
                        "query": request.url.query,
                    },
                )
            except Exception:  # noqa: BLE001
                pass
            raise
