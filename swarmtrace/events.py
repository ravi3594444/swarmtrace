"""Lightweight, typed event bus for SwarmTrace span lifecycle events.

This module provides loose coupling between the tracing core and optional
subscribers such as the FOV sender, alert runner, budget tracker, or custom
user hooks. It is intentionally minimal: it does not use an external broker
and keeps events in-process.

Example::

    from swarmtrace.events import on, emit

    @on("span.recorded")
    def my_handler(span):
        print(f"recorded {span.name}")

    emit("span.recorded", span=span_record)
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

_log = logging.getLogger("swarmtrace.events")

EventHandler = Callable[..., Any]

# Global listener registry. Protected by _lock so emit() is thread-safe.
_listeners: dict[str, list[EventHandler]] = {}
_lock = threading.Lock()


def on(event_type: str, handler: EventHandler | None = None) -> EventHandler:
    """Register a handler for ``event_type``.

    Can be used as a decorator or as a direct call:

        @on("span.recorded")
        def my_handler(span): ...

        on("span.recorded", my_handler)

    Returns the handler so it can be used as a decorator.
    """
    def _register(h: EventHandler) -> EventHandler:
        with _lock:
            _listeners.setdefault(event_type, []).append(h)
        return h

    if handler is None:
        return _register
    return _register(handler)


def off(event_type: str, handler: EventHandler) -> bool:
    """Remove a previously registered handler. Returns True if it existed."""
    with _lock:
        handlers = _listeners.get(event_type, [])
        if handler in handlers:
            handlers.remove(handler)
            return True
    return False


def emit(event_type: str, **kwargs: Any) -> None:
    """Emit an event to all registered handlers.

    Handlers are called synchronously on the caller's thread. Exceptions are
    caught and logged individually so that one bad subscriber cannot break the
    tracing core or the caller's execution.
    """
    with _lock:
        handlers = list(_listeners.get(event_type, []))

    for handler in handlers:
        try:
            handler(**kwargs)
        except Exception as exc:  # noqa: BLE001 -- one bad subscriber must not break tracing, see docstring above
            _log.warning("event handler for %s failed: %s", event_type, exc)


def listeners(event_type: str) -> list[EventHandler]:
    """Return a snapshot of handlers for ``event_type``."""
    with _lock:
        return list(_listeners.get(event_type, []))


def reset() -> None:
    """Clear all listeners. Intended for tests only."""
    global _listeners
    with _lock:
        _listeners = {}


__all__ = ["emit", "listeners", "off", "on", "reset"]
