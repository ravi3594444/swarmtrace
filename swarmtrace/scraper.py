import logging
import time
import uuid
from datetime import datetime, timezone
from swarmtrace.storage import save_trace
from swarmtrace.tracer import _parent_ctx, _current_parent, _current_agent

_log = logging.getLogger("swarmtrace.scraper")

def scrape(url: str, verbose=True):
    """
    Trace a web scraping call using Scrapling.
    Usage:
        from swarmtrace.scraper import scrape
        result = scrape("https://news.ycombinator.com")

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
        save_trace(
            id_=trace_id, parent_id=parent_id, function="scrape",
            args=url, output=result[:200] if result else None,
            latency_sec=latency, error=error,
            timestamp=datetime.now(timezone.utc).isoformat(),
            input_tokens=len(url) // 4, output_tokens=output_tokens, cost_usd=cost,
            kind="tool", agent_id=agent_id, agent_name=agent_name,
        )
        _parent_ctx.reset(token)

    if _exc is not None:
        raise _exc
    return result