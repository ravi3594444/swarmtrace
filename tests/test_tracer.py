"""Tests for the @observe decorator (sync, async, linkage, errors)."""

import asyncio

import pytest

import tracely.tracer as tracer


@pytest.fixture()
def records(monkeypatch):
    """Capture save_trace calls instead of writing to the real SQLite DB."""
    saved = []
    monkeypatch.setattr(tracer, "save_trace", lambda *a, **k: saved.append(a))
    # Ensure remote ingest stays disabled regardless of the host environment.
    monkeypatch.delenv("SWARMTRACE_API_KEY", raising=False)
    monkeypatch.delenv("SWARMTRACE_ENDPOINT", raising=False)
    return saved


def test_sync_trace_saved(records):
    @tracer.observe
    def add(a, b):
        return a + b

    assert add(2, 3) == 5
    assert len(records) == 1
    row = records[0]
    assert row[2] == "add"      # function name
    assert row[4] == "5"        # output
    assert row[6] is None       # no error
    assert len(row[0]) == 32    # full uuid4 hex — collision-safe


def test_parent_child_linkage(records):
    @tracer.observe
    def child():
        return "c"

    @tracer.observe
    def parent():
        child()
        return "p"

    parent()
    child_row = next(r for r in records if r[2] == "child")
    parent_row = next(r for r in records if r[2] == "parent")
    assert child_row[1] == parent_row[0]
    assert parent_row[1] is None


def test_error_captured_and_reraised(records):
    @tracer.observe
    def boom():
        raise ValueError("nope")

    with pytest.raises(ValueError):
        boom()
    assert records[0][6] == "nope"


def test_flush_failure_never_masks_user_exception(records, monkeypatch):
    monkeypatch.setattr(
        tracer, "_flush", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down"))
    )

    @tracer.observe
    def boom():
        raise ValueError("the real error")

    with pytest.raises(ValueError, match="the real error"):
        boom()


def test_async_trace_saved(records):
    @tracer.observe
    async def aadd(a, b):
        return a + b

    assert asyncio.run(aadd(1, 2)) == 3
    assert len(records) == 1
    assert records[0][2] == "aadd"
    assert records[0][4] == "3"
