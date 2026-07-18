import logging
import time
import uuid
from datetime import datetime, timezone

from swarmtrace.runtime import get_runtime
from swarmtrace.span_model import SpanRecord
from swarmtrace.trace_context import _parent_ctx, current_agent, current_parent

# Compatibility aliases used by older tests that monkeypatch scraper internals.
_current_parent = current_parent
_current_agent = current_agent

_log = logging.getLogger("swarmtrace.scraper")

def scrape(url: str, verbose=True, kind: str = "tool"):
    """
    Trace a web scraping call using Scrapling.
    Usage:
        from swarmtrace.scraper import scrape
        result = scrape("https://news.ycombinator.com")

    kind: span kind for the trace. Defaults to 'tool'. Override to
    'function' for generic function calls, or 'retrieval' when the
    scrape is part of a RAG document-loading pipeline (matches the
    kind taxonomy in docs/SDK_DASHBOARD_CONTRACT.md). Whatever you
    pick rolls up into the enclosing @observe agent's stats — it
    never becomes its own phantom agent card.

    Raises the underlying exception on failure (after saving the trace)
    so callers are not silently handed a None.
    """
    trace_id = uuid.uuid4().hex  # full 32-char hex — short IDs are collision-prone
    parent_id = _current_parent()
    agent_id, agent_name = _current_agent() or (None, None)
    token = _parent_ctx.set(trace_id)

    indent = "  " if parent_id else ""
    if verbose:
        _log.info("%s▶ scrape started (id=%s) url=%s", indent, trace_id, url[:60])

    start = time.perf_counter()
    error = None
    result = None
    bytes_scraped = 0
    _exc = None

    try:
        from scrapling.fetchers import Fetcher
        page = Fetcher().get(url, timeout=30)
        result = page.get_all_text(ignore_tags=("script", "style"))
        bytes_scraped = len(result.encode("utf-8"))
    except Exception as e:
        error = str(e)
        _exc = e
    finally:
        latency = round(time.perf_counter() - start, 3)
        output_tokens = bytes_scraped // 4
        cost = round(output_tokens * 0.80 / 1_000_000, 8)
        status = "✗ FAILED" if error else "✓ done"
        if verbose:
            _log.info(
                "%s%s: scrape | %ss | %d bytes | $%s",
                indent, status, latency, bytes_scraped, cost,
            )
        span = SpanRecord(
            span_id=trace_id,
            parent_span_id=parent_id,
            name="scrape",
            kind=kind,
            start_time=datetime.now(timezone.utc),
            latency_sec=latency,
            args=url,
            output=result[:200] if result else None,
            error=error,
            input_tokens=len(url) // 4,
            output_tokens=output_tokens,
            cost_usd=cost,
            agent_id=agent_id,
            agent_name=agent_name,
        )
        get_runtime().record(span)
        _parent_ctx.reset(token)

    if _exc is not None:
        raise _exc
    return result