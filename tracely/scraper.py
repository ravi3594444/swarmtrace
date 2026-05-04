import time
import uuid
from datetime import datetime, timezone
from tracely.storage import save_trace
from tracely.tracer import _parent_ctx, _current_parent

def scrape(url: str, verbose=True):
    """
    Trace a web scraping call using Scrapling.
    Usage:
        from tracely.scraper import scrape
        result = scrape("https://news.ycombinator.com")
    """
    trace_id = uuid.uuid4().hex[:8]
    parent_id = _current_parent()
    token = _parent_ctx.set(trace_id)

    indent = "  " if parent_id else ""
    if verbose:
        print(f"[swarmtrace] {indent}▶ scrape started (id={trace_id}) url={url[:60]}")

    start = time.perf_counter()
    error = None
    result = None
    bytes_scraped = 0

    try:
        from scrapling.fetchers import Fetcher
        page = Fetcher().get(url)
        result = page.get_all_text(ignore_tags=("script", "style"))
        bytes_scraped = len(result.encode("utf-8"))
    except Exception as e:
        error = str(e)
    finally:
        latency = round(time.perf_counter() - start, 3)
        output_tokens = bytes_scraped // 4
        cost = round(output_tokens * 0.80 / 1_000_000, 8)
        status = "✗ FAILED" if error else "✓ done"
        if verbose:
            print(f"[swarmtrace] {indent}{status}: scrape | {latency}s | {bytes_scraped} bytes | ${cost}")
        save_trace(
            trace_id, parent_id, "scrape",
            url, result[:200] if result else None,
            latency, error,
            datetime.now(timezone.utc).isoformat(),
            len(url) // 4, output_tokens, cost
        )
        _parent_ctx.reset(token)

    if error:
        print(f"[swarmtrace] Scrape Error: {error}")
        return None
    return result
