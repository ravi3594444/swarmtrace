"""Generic root-run and child-span APIs for SwarmTrace."""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # typing.Self is 3.11+; this package supports 3.10. Safe under
    # `from __future__ import annotations` since annotations are never
    # evaluated at runtime, only by type checkers.
    from typing import Self

from swarmtrace.runtime import get_runtime
from swarmtrace.span_model import SpanRecord
from swarmtrace.trace_context import (
    TraceContext,
    current_agent,
    current_parent,
    current_session,
    current_trace,
    using,
)

# The innermost active _SpanContext, so current_span_attributes() can find the
# span it is meant to annotate. A ContextVar (not a module global) so threads
# and asyncio tasks each see their own stack.
_active_span: ContextVar[_SpanContext | None] = ContextVar(
    "swarmtrace_active_span", default=None
)


_log = logging.getLogger("swarmtrace")


def _stable_agent_id(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest()


def _now() -> tuple[float, datetime]:
    return time.perf_counter(), datetime.now(timezone.utc)


class _SpanContext:
    """Context manager that records a span and propagates trace context."""

    def __init__(
        self,
        name: str,
        kind: str,
        session_id: str | None = None,
        *,
        is_run: bool = False,
        attributes: dict[str, Any] | None = None,
    ):
        self.name = name
        self.kind = kind
        self.session_id = session_id
        self.is_run = is_run
        self.attributes = attributes or {}
        self.span_id = uuid.uuid4().hex
        self._start: float = 0.0
        self._start_time: datetime | None = None
        self._error: str | None = None
        self._ctx_manager: object | None = None
        self._active_token: object | None = None
        self.parent_id: str | None = None
        self.trace_id: str | None = None
        self.agent_id: str | None = None
        self.agent_name: str | None = None

    def _build_trace_context(self) -> TraceContext:
        parent = current_parent()
        trace_id = current_trace()
        enclosing_agent = current_agent()
        self.parent_id = parent
        self.trace_id = trace_id or self.span_id
        if self.is_run and self.kind == "agent":
            self.agent_id = _stable_agent_id(self.name)
            self.agent_name = self.name
        else:
            self.agent_id, self.agent_name = enclosing_agent or (None, None)
        session_id = self.session_id if self.session_id is not None else current_session()
        self.session_id = session_id
        return TraceContext(
            span_id=self.span_id,
            parent_span_id=self.parent_id,
            trace_id=self.trace_id,
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            session_id=session_id,
        )

    def _record(self, exc: BaseException | None) -> None:
        self._error = str(exc) if exc is not None else None
        latency = round(time.perf_counter() - self._start, 3)
        end_time = datetime.now(timezone.utc)
        span = SpanRecord(
            span_id=self.span_id,
            parent_span_id=self.parent_id,
            trace_id=self.trace_id,
            name=self.name,
            kind=self.kind,
            start_time=self._start_time or end_time,
            end_time=end_time,
            status="error" if exc is not None else "ok",
            latency_sec=latency,
            error=self._error,
            agent_id=self.agent_id,
            agent_name=self.agent_name,
            session_id=self.session_id,
            attributes=self.attributes,
        )
        get_runtime().record(span)

    def __enter__(self) -> Self:
        self._start, self._start_time = _now()
        self._ctx_manager = using(self._build_trace_context())
        self._ctx_manager.__enter__()
        self._active_token = _active_span.set(self)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            # Reset BEFORE recording so an annotation racing the close cannot
            # mutate self.attributes while _record is snapshotting it.
            if self._active_token is not None:
                _active_span.reset(self._active_token)
                self._active_token = None
            self._record(exc)
        finally:
            if self._ctx_manager is not None:
                self._ctx_manager.__exit__(exc_type, exc, tb)

    async def __aenter__(self) -> Self:
        return self.__enter__()

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return self.__exit__(exc_type, exc, tb)


def run(
    name: str,
    *,
    session_id: str | None = None,
    kind: str = "agent",
    attributes: dict[str, Any] | None = None,
) -> _SpanContext:
    return _SpanContext(name, kind=kind, session_id=session_id, is_run=True, attributes=attributes)


def span(
    name: str,
    *,
    kind: str = "function",
    attributes: dict[str, Any] | None = None,
) -> _SpanContext:
    return _SpanContext(name, kind=kind, is_run=False, attributes=attributes)


@contextmanager
def current_span_attributes(**attrs: Any):
    """Attach ``attrs`` to the innermost enclosing ``run()`` / ``span()``.

    The attributes land on that span's ``attributes``, so they reach local
    SQLite and the dashboard exactly as ``span(name, attributes={...})`` does::

        with swarmtrace.span("retrieve", kind="tool"):
            with swarmtrace.current_span_attributes(stage="retrieval", k=1):
                ...

    This used to only ``emit("span.annotate", ...)`` and mutate nothing, on the
    theory that listeners would handle enrichment — but nothing in the package
    ever subscribed to that event, so a documented, exported API silently
    discarded everything passed to it: the attributes never reached the span,
    SQLite, or the wire. The event is still emitted, so any existing subscriber
    keeps working.

    Known limitation: only ``run()`` / ``span()`` spans are annotatable.
    ``@observe`` builds its span record from locals with no mutable span object
    to attach to, so an annotation inside a bare ``@observe`` function has
    nowhere to go; it is logged at debug rather than silently dropped.
    """
    from swarmtrace.events import emit

    span_ctx = _active_span.get()
    if span_ctx is None:
        _log.debug(
            "current_span_attributes(%s) called with no active run()/span() — "
            "attributes not attached to any span",
            ", ".join(attrs),
        )
    else:
        span_ctx.attributes.update(attrs)

    emit("span.annotate", **attrs)
    try:
        yield
    finally:
        pass


__all__ = ["current_span_attributes", "run", "span"]
