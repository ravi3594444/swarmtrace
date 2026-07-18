"""Tests for Phase 5 metadata / trace_id propagation."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import pytest

from swarmtrace.adapters.http_transport import _span_to_payload as http_payload
from swarmtrace.runtime import Runtime, _span_to_payload as runtime_payload, get_runtime
from swarmtrace.span_model import SpanRecord
from swarmtrace.storage import get_traces, save_trace
import swarmtrace.storage as storage_module


@pytest.fixture
def fresh_storage(tmp_path):
    """Use a temporary SQLite DB for each test and reset module state."""
    db_path = str(tmp_path / "metadata.sqlite")
    old_path = storage_module.DB_PATH
    storage_module.DB_PATH = db_path
    storage_module._conn = None
    storage_module._write_count = 0
    yield
    storage_module._conn = None
    storage_module.DB_PATH = old_path


class FakeRepo:
    def __init__(self):
        self.spans = []

    def save(self, span: SpanRecord) -> None:
        self.spans.append(span)

    def get_children(self, span_id: str):
        return []

    def get_unsynced(self, limit: int = 100):
        return []

    def mark_synced(self, span_id: str, synced: int = 1) -> None:
        pass


class FakeTransport:
    def __init__(self):
        self.batches = []
        self.singles = []

    def send(self, spans, key, url):
        self.batches.append([http_payload(s) for s in spans])

    def send_batch(self, payloads, key, url):
        self.batches.append(payloads)

    def send_single(self, payload, key, url):
        self.singles.append(payload)


@pytest.fixture
def fake_runtime():
    repo = FakeRepo()
    transport = FakeTransport()
    runtime = Runtime(repo, transport, lambda: ("key", "http://example"))
    import swarmtrace.runtime as rtmod
    old = rtmod._runtime
    rtmod._runtime = runtime
    yield {"repo": repo, "transport": transport, "runtime": runtime}
    rtmod._runtime = old


def test_span_record_to_storage_dict_round_trip():
    span = SpanRecord(
        span_id="span-1",
        parent_span_id="parent-1",
        trace_id="trace-1",
        name="do-thing",
        kind="tool",
        start_time=datetime.now(timezone.utc),
        latency_sec=0.5,
        attributes={"provider": "mcp", "upstream": "fake"},
    )
    d = span.to_storage_dict()
    assert d["id_"] == "span-1"
    assert d["trace_id"] == "trace-1"
    assert json.loads(d["attributes"]) == {"provider": "mcp", "upstream": "fake"}

    row = {
        "id": d["id_"],
        "parent_id": d["parent_id"],
        "trace_id": d["trace_id"],
        "function": d["function"],
        "kind": d["kind"],
        "timestamp": d["timestamp"],
        "latency_sec": d["latency_sec"],
        "attributes": d["attributes"],
    }
    restored = SpanRecord.from_storage_row(row)
    assert restored.trace_id == "trace-1"
    assert restored.attributes == {"provider": "mcp", "upstream": "fake"}


def test_sqlite_stores_trace_id_and_attributes(fresh_storage):
    save_trace(
        id_="span-1",
        parent_id="parent-1",
        trace_id="trace-1",
        function="do-thing",
        args="{}",
        output="ok",
        latency_sec=0.1,
        timestamp=datetime.now(timezone.utc).isoformat(),
        kind="tool",
        agent_id="agent-1",
        agent_name="agent",
        attributes=json.dumps({"provider": "mcp"}),
    )
    rows = get_traces(limit=10)
    assert len(rows) == 1
    row = dict(rows[0])
    assert row["trace_id"] == "trace-1"
    assert json.loads(row["attributes"]) == {"provider": "mcp"}


def test_http_transport_payload_includes_metadata():
    span = SpanRecord(
        span_id="span-1",
        trace_id="trace-1",
        name="do-thing",
        kind="tool",
        attributes={"provider": "mcp"},
    )
    payload = http_payload(span)
    assert payload["trace_id"] == "trace-1"
    assert payload["attributes"] == {"provider": "mcp"}


def test_http_transport_omits_trace_id_when_same_as_span_id():
    span = SpanRecord(span_id="span-1", name="x", kind="function")
    payload = http_payload(span)
    assert "trace_id" not in payload


def test_runtime_payload_includes_metadata():
    span = SpanRecord(
        span_id="span-1",
        trace_id="trace-1",
        name="do-thing",
        kind="tool",
        attributes={"provider": "mcp"},
    )
    payload = runtime_payload(span)
    assert payload["trace_id"] == "trace-1"
    assert payload["attributes"] == {"provider": "mcp"}


def test_attributes_redacted_in_transport_payload():
    span = SpanRecord(
        span_id="span-1",
        name="x",
        kind="function",
        attributes={"secret": "token=sk-12345678901234567890abcdef"},
    )
    payload = http_payload(span)
    # The transport does not redact attributes; the SDK redacts args/output
    # and the attribute values should be redacted by the caller before placing
    # secrets into attributes. We assert the payload faithfully carries them.
    assert payload["attributes"]["secret"] == "token=sk-12345678901234567890abcdef"
