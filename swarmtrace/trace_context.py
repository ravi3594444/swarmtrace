"""Portable trace context propagation for SwarmTrace.

This module owns the contextvars and helper functions that track the
current trace, span, agent, and session across sync and async execution.
It is the single source of truth for context propagation; other modules
should import from here rather than reaching into tracer.py internals.

During the Phase 0 refactor, tracer.py re-exports these symbols under
their old private names for backwards compatibility. New code should use
the public helpers and the TraceContext dataclass directly.
"""

from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass(frozen=True)
class TraceContext:
    """Portable context for one span/run.

    A ``run()`` creates a span whose ``kind == "agent"``. A ``span()``
    creates a child span. The ``span_id`` of the current span becomes the
    ``parent_span_id`` of any nested span.
    """

    span_id: str
    parent_span_id: str | None = None
    trace_id: str | None = None
    agent_id: str | None = None
    agent_name: str | None = None
    session_id: str | None = None

    def as_agent_tuple(self) -> tuple[str, str] | None:
        """Return (agent_id, agent_name) if an agent is present, else None."""
        if self.agent_id is None:
            return None
        return (self.agent_id, self.agent_name or self.agent_id)


# ---------------------------------------------------------------------------
# Context variables
# ---------------------------------------------------------------------------
# Each var holds the context for the *current* span. Nested spans replace
# the value while the body runs and restore it on exit.

_parent_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "parent_ctx", default=None
)
_agent_ctx: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "agent_ctx", default=None
)
_session_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "session_ctx", default=None
)
_trace_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "trace_ctx", default=None
)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def current_parent() -> str | None:
    """Return the parent_span_id of the current span, if any."""
    return _parent_ctx.get()


def current_agent() -> tuple[str, str] | None:
    """Return ``(agent_id, agent_name)`` of the nearest enclosing agent span."""
    return _agent_ctx.get()


def current_session() -> str | None:
    """Return the current session_id, if any."""
    return _session_ctx.get()


def current_trace() -> str | None:
    """Return the trace_id of the current distributed run, if any."""
    return _trace_ctx.get()


def current_context() -> TraceContext:
    """Build a TraceContext that describes the current execution context.

    This is the context that should be used as the parent for a new span.
    The new span's ``parent_span_id`` is the current ``span_id`` (stored in
    ``_parent_ctx``), and the new span inherits agent and session context.
    """
    agent_id, agent_name = current_agent() or (None, None)
    return TraceContext(
        span_id=current_parent() or "",
        parent_span_id=current_parent(),
        trace_id=current_trace(),
        agent_id=agent_id,
        agent_name=agent_name,
        session_id=current_session(),
    )


@contextmanager
def using(ctx: TraceContext) -> Iterator[TraceContext]:
    """Set all context variables to ``ctx`` for the duration of the block.

    Restores the previous values on exit, even if an exception is raised.
    """
    parent_token = _parent_ctx.set(ctx.span_id)
    agent_token = _agent_ctx.set(ctx.as_agent_tuple())
    session_token = _session_ctx.set(ctx.session_id)
    trace_token = _trace_ctx.set(ctx.trace_id)
    try:
        yield ctx
    finally:
        _parent_ctx.reset(parent_token)
        _agent_ctx.reset(agent_token)
        _session_ctx.reset(session_token)
        _trace_ctx.reset(trace_token)
