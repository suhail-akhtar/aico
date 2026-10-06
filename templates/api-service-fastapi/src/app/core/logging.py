"""Structured JSON logging to stdout, one event per line.

stdout JSON is what every log shipper understands; a container runtime collects
it with no agent in the image. Standard-library loggers (uvicorn, SQLAlchemy,
Alembic) are routed through the same formatter so the stream is uniformly JSON.

Two guards that matter more than the format:
- Redaction by key name. A field called `password`, `token`, `secret`,
  `authorization` or `cookie` is replaced before it can reach a sink, however it
  got into the event.
- Trace correlation. When OpenTelemetry is on, each line carries the active
  trace and span ids so a log can be found from a trace and back.
"""

import logging
import sys
from collections.abc import MutableMapping
from typing import Any, TextIO

import structlog
from opentelemetry import trace

SENSITIVE_FRAGMENTS = (
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "api_key",
    "apikey",
)
REDACTED = "[redacted]"

EventDict = MutableMapping[str, Any]


def _redact_value(key: str, value: Any) -> Any:
    if any(fragment in key.lower() for fragment in SENSITIVE_FRAGMENTS):
        return REDACTED
    if isinstance(value, dict):
        return {k: _redact_value(str(k), v) for k, v in value.items()}
    return value


def redact(_logger: object, _method: str, event_dict: EventDict) -> EventDict:
    for key in list(event_dict):
        event_dict[key] = _redact_value(key, event_dict[key])
    return event_dict


def add_trace_ids(_logger: object, _method: str, event_dict: EventDict) -> EventDict:
    context = trace.get_current_span().get_span_context()
    if context.is_valid:
        event_dict["trace_id"] = format(context.trace_id, "032x")
        event_dict["span_id"] = format(context.span_id, "016x")
    return event_dict


def configure_logging(level: str = "INFO", fmt: str = "json", stream: TextIO | None = None) -> None:
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        add_trace_ids,
        redact,
    ]
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )
    renderer: Any = (
        structlog.processors.JSONRenderer()
        if fmt == "json"
        else structlog.dev.ConsoleRenderer(colors=False)
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            # show_locals=False: a traceback with locals prints every variable in scope,
            # which in an auth service includes the plaintext password.
            structlog.processors.ExceptionRenderer(
                structlog.tracebacks.ExceptionDictTransformer(show_locals=False)
            )
            if fmt == "json"
            else structlog.dev.set_exc_info,
            renderer,
        ],
    )
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # uvicorn installs its own handlers; hand its records to ours instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        named = logging.getLogger(name)
        named.handlers.clear()
        named.propagate = True
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
