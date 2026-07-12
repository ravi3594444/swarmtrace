"""Tests for swarmtrace/scraper.py.

Audit finding #8: scraper.py had zero test coverage.

`scrapling` is an optional dependency (`pip install swarmtrace[scraper]`)
and is not installed in this environment, so these tests inject a fake
`scrapling.fetchers.Fetcher` into sys.modules -- exercising the real
import-and-call path in scraper.py without requiring the real (heavy,
browser-automation-adjacent) package.
"""

from __future__ import annotations

import sys
import types

import pytest

import swarmtrace.scraper as scraper
import swarmtrace.tracer as tracer


class _FakePage:
    def __init__(self, text: str):
        self._text = text

    def get_all_text(self, ignore_tags=()):
        return self._text


class _FakeFetcher:
    """Stands in for scrapling.fetchers.Fetcher."""

    last_get_kwargs = None

    def __init__(self, *args, **kwargs):
        pass

    def get(self, url, timeout=30):
        _FakeFetcher.last_get_kwargs = {"url": url, "timeout": timeout}
        return _FakePage(_FAKE_PAGE_TEXT)


class _FailingFetcher:
    def __init__(self, *args, **kwargs):
        pass

    def get(self, url, timeout=30):
        raise ConnectionError("could not reach host")


_FAKE_PAGE_TEXT = "Hello from the fake scraped page. " * 3


def _install_fake_scrapling(fetcher_cls):
    fetchers_mod = types.ModuleType("scrapling.fetchers")
    fetchers_mod.Fetcher = fetcher_cls
    scrapling_pkg = types.ModuleType("scrapling")
    scrapling_pkg.fetchers = fetchers_mod
    sys.modules["scrapling"] = scrapling_pkg
    sys.modules["scrapling.fetchers"] = fetchers_mod


@pytest.fixture()
def fake_scrapling_ok():
    _install_fake_scrapling(_FakeFetcher)
    yield
    sys.modules.pop("scrapling", None)
    sys.modules.pop("scrapling.fetchers", None)


@pytest.fixture()
def fake_scrapling_failing():
    _install_fake_scrapling(_FailingFetcher)
    yield
    sys.modules.pop("scrapling", None)
    sys.modules.pop("scrapling.fetchers", None)


@pytest.fixture()
def records(monkeypatch):
    """Capture save_trace calls instead of writing to the real SQLite DB."""
    saved = []

    def _capture(**kwargs):
        saved.append(kwargs)

    monkeypatch.setattr(scraper, "save_trace", _capture)
    return saved


def test_scrape_returns_page_text(fake_scrapling_ok, records):
    result = scraper.scrape("https://example.com", verbose=False)
    assert result == _FAKE_PAGE_TEXT


def test_scrape_saves_a_trace_with_kind_tool(fake_scrapling_ok, records):
    scraper.scrape("https://example.com", verbose=False)
    assert len(records) == 1
    row = records[0]
    assert row["kind"] == "tool"
    assert row["function"] == "scrape"
    assert row["error"] is None


def test_scrape_trace_id_is_full_32char_hex(fake_scrapling_ok, records):
    scraper.scrape("https://example.com", verbose=False)
    trace_id = records[0]["id_"]
    assert len(trace_id) == 32
    int(trace_id, 16)  # raises ValueError if not valid hex


def test_scrape_output_is_truncated_to_200_chars_in_trace(fake_scrapling_ok, records):
    scraper.scrape("https://example.com", verbose=False)
    saved_output = records[0]["output"]
    assert len(saved_output) <= 200
    assert saved_output == _FAKE_PAGE_TEXT[:200]


def test_scrape_computes_cost_from_bytes_scraped(fake_scrapling_ok, records):
    scraper.scrape("https://example.com", verbose=False)
    row = records[0]
    expected_bytes = len(_FAKE_PAGE_TEXT.encode("utf-8"))
    expected_out_tokens = expected_bytes // 4
    expected_cost = round(expected_out_tokens * 0.80 / 1_000_000, 8)
    assert row["output_tokens"] == expected_out_tokens
    assert row["cost_usd"] == expected_cost


def test_scrape_input_tokens_from_url_length(fake_scrapling_ok, records):
    url = "https://example.com/some/path"
    scraper.scrape(url, verbose=False)
    assert records[0]["input_tokens"] == len(url) // 4


def test_scrape_inherits_parent_id_from_context(fake_scrapling_ok, records):
    token = tracer._parent_ctx.set("parent-trace-123")
    try:
        scraper.scrape("https://example.com", verbose=False)
    finally:
        tracer._parent_ctx.reset(token)
    assert records[0]["parent_id"] == "parent-trace-123"


def test_scrape_inherits_agent_context(fake_scrapling_ok, records):
    token = tracer._agent_ctx.set(("agent-42", "my_researcher"))
    try:
        scraper.scrape("https://example.com", verbose=False)
    finally:
        tracer._agent_ctx.reset(token)
    assert records[0]["agent_id"] == "agent-42"
    assert records[0]["agent_name"] == "my_researcher"


def test_scrape_with_no_parent_context_has_none_parent_id(fake_scrapling_ok, records):
    scraper.scrape("https://example.com", verbose=False)
    assert records[0]["parent_id"] is None


def test_scrape_resets_parent_ctx_after_call(fake_scrapling_ok, records):
    """_parent_ctx must be reset even on success, so a sibling call right
    after doesn't see the scrape's trace_id as its parent."""
    assert tracer._current_parent() is None
    scraper.scrape("https://example.com", verbose=False)
    assert tracer._current_parent() is None


def test_scrape_raises_underlying_exception_on_failure(fake_scrapling_failing, records):
    """Docstring contract: 'Raises the underlying exception on failure
    (after saving the trace) so callers are not silently handed a None.'"""
    with pytest.raises(ConnectionError, match="could not reach host"):
        scraper.scrape("https://example.com", verbose=False)


def test_scrape_saves_error_trace_on_failure(fake_scrapling_failing, records):
    with pytest.raises(ConnectionError):
        scraper.scrape("https://example.com", verbose=False)
    assert len(records) == 1
    row = records[0]
    assert row["error"] == "could not reach host"
    assert row["output"] is None
    assert row["kind"] == "tool"


def test_scrape_resets_parent_ctx_even_on_failure(fake_scrapling_failing, records):
    assert tracer._current_parent() is None
    with pytest.raises(ConnectionError):
        scraper.scrape("https://example.com", verbose=False)
    assert tracer._current_parent() is None


def test_scrape_failure_has_zero_cost_and_tokens(fake_scrapling_failing, records):
    with pytest.raises(ConnectionError):
        scraper.scrape("https://example.com", verbose=False)
    row = records[0]
    assert row["output_tokens"] == 0
    assert row["cost_usd"] == 0.0
