"""Application paths and process-wide logging configuration."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import tempfile
import threading


APP_LOG_HANDLER_MARKER = "_ai_novel_app_log_handler"
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def get_application_dir() -> Path:
    """Return the portable application directory in source and packaged builds."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def get_config_path() -> Path:
    return get_application_dir() / "config.json"


def get_log_path() -> Path:
    return get_application_dir() / "app.log"


def _rewrite_legacy_log_as_utf8(log_path: Path) -> None:
    """Convert legacy Windows-encoded logs before opening the UTF-8 handler."""
    if not log_path.exists() or not log_path.stat().st_size:
        return

    raw_content = log_path.read_bytes()
    try:
        raw_content.decode("utf-8")
        return
    except UnicodeDecodeError:
        decoded_content = raw_content.decode("gb18030", errors="replace")

    fd, temp_path = tempfile.mkstemp(suffix=".log", dir=str(log_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(decoded_content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, log_path)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise


def configure_app_logging(
    log_path: str | os.PathLike[str] | None = None,
    *,
    max_bytes: int = 2 * 1024 * 1024,
    backup_count: int = 3,
) -> Path:
    """Configure one UTF-8 rotating file handler and return its path."""
    target = Path(log_path) if log_path is not None else get_log_path()
    target = target.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)

    root_logger = logging.getLogger()
    for handler in root_logger.handlers:
        if (
            getattr(handler, APP_LOG_HANDLER_MARKER, False)
            and Path(handler.baseFilename).resolve() == target
        ):
            return target

    _rewrite_legacy_log_as_utf8(target)
    handler = RotatingFileHandler(
        target,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
        delay=True,
    )
    setattr(handler, APP_LOG_HANDLER_MARKER, True)
    handler.setFormatter(logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT))
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)
    return target


def install_exception_logging() -> None:
    """Record otherwise unhandled main-thread and worker-thread failures."""
    previous_sys_hook = sys.excepthook
    previous_thread_hook = threading.excepthook

    def log_main_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            previous_sys_hook(exc_type, exc_value, exc_traceback)
            return
        logging.critical(
            "Unhandled application exception",
            exc_info=(exc_type, exc_value, exc_traceback),
        )

    def log_thread_exception(args):
        logging.critical(
            "Unhandled exception in thread %s",
            args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )
        if args.exc_type is SystemExit:
            previous_thread_hook(args)

    sys.excepthook = log_main_exception
    threading.excepthook = log_thread_exception
