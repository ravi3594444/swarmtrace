"""Tests for SDK-side batching + gzip (task 4) and the extracted Sender (1.B).

Covers:
  - drain_batch: 20 items or 2s, whichever first; blocks for the first
    item then drains non-blocking.
  - HttpTransport.send_batch: gzip + ``{"traces": [...]}`` body + headers.
  - Sender._send_with_retries: on success marks every row synced=1; on
    failure (3 retries exhausted) leaves every row synced=0.
  - session_id survives the batch round-trip.
  - resync still uses the single-object path (not the batch path).

Phase 1.B: drain/worker logic moved to ``swarmtrace.delivery.sender.Sender``;
these tests now drive a ``Sender`` with a fake transport + fake/no-op sleep
instead of patching ``tracer._send_queue`` / ``tracer._send_batch_remote`` /
``tracer._worker_started``.
"""

from __future__ import annotations

import gzip
import importlib
import json
import queue
import threading
import time
from unittest.mock import patch

import pytest

from swarmtrace import storage, tracer
from swarmtrace.delivery.sender import Sender

# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------

class FakeTransport:
    """Records every batch send; optionally raises to simulate failure."""

    def __init__(self, *, raise_on=None):
        self.batches = []
        self.raise_on = raise_on

    def send_batch(self, payloads, key, url):
        if self.raise_on is not None:
            raise self.raise_on
        self.batches.append(list(payloads))


class _NullRepo:
    """No-op repository for tests that don't need a DB."""

    def mark_synced(self, trace_id, synced=1):
        pass


def _config():
    return "test-key", "https://example.test"


def _sender(transport, repository, *, sleep=lambda s: None, **kw):
    return Sender(transport, repository, _config, sleep=sleep, **kw)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------

@pytest.fixture()
def fresh_storage(tmp_path, monkeypatch):
    """Reload storage + tracer against a temp DB and a configured remote."""
    monkeypatch.setenv("SWARMTRACE_DB_PATH", str(tmp_path / "traces.db"))
    monkeypatch.setenv("SWARMTRACE_API_KEY", "test-key")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://example.test")
    importlib.reload(storage)
    tracer.save_trace = storage.save_trace
    tracer.mark_synced = storage.mark_synced
    # Drain any leftover payloads from the module sender's queue.
    q = tracer._sender._queue
    while not q.empty():
        try:
            q.get_nowait()
            q.task_done()
        except queue.Empty:
            break
    yield storage
    if storage._conn is not None:
        storage.close()


# --------------------------------------------------------------------------
# Sender.drain_batch — the "20 items or 2s, whichever first" logic
# --------------------------------------------------------------------------

class TestDrainBatch:
    def test_blocks_then_returns_first_item(self):
        s = _sender(FakeTransport(), _NullRepo())
        s._queue.put_nowait({"id": "a"})
        batch = s.drain_batch(max_items=20, timeout=2.0)
        assert len(batch) == 1
        assert batch[0]["id"] == "a"

    def test_drains_up_to_max_items(self):
        s = _sender(FakeTransport(), _NullRepo())
        for i in range(25):
            s._queue.put_nowait({"id": f"t{i}"})
        batch = s.drain_batch(max_items=20, timeout=0.1)
        assert len(batch) == 20
        assert [p["id"] for p in batch] == [f"t{i}" for i in range(20)]
        # The remaining 5 stay in the queue for the next drain.
        assert s._queue.qsize() == 5

    def test_returns_empty_on_timeout(self):
        s = _sender(FakeTransport(), _NullRepo())
        start = time.monotonic()
        batch = s.drain_batch(max_items=20, timeout=0.2)
        elapsed = time.monotonic() - start
        assert batch == []
        assert 0.15 <= elapsed <= 0.5  # roughly the timeout, not 0

    def test_drains_available_items_non_blocking_after_first(self):
        s = _sender(FakeTransport(), _NullRepo())
        s._queue.put_nowait({"id": "a"})
        s._queue.put_nowait({"id": "b"})
        s._queue.put_nowait({"id": "c"})
        batch = s.drain_batch(max_items=20, timeout=2.0)
        assert len(batch) == 3  # all 3 were immediately available


# --------------------------------------------------------------------------
# HttpTransport.send_batch — gzip + body shape + headers
# (patched at the adapter, not tracer — Phase 1.A)
# --------------------------------------------------------------------------

class TestSendBatchRemote:
    def test_body_is_traces_array_shape(self):
        captured = {}
        class FakeReq:
            def __init__(self, url, data, headers, method):
                captured["url"] = url
                captured["data"] = data
                captured["headers"] = headers
                captured["method"] = method
        def fake_urlopen(req, timeout):
            return None

        payloads = [{"id": "t1", "function": "f"}, {"id": "t2", "function": "g"}]
        with patch("swarmtrace.adapters.http_transport.Request", FakeReq), \
             patch("swarmtrace.adapters.http_transport.urlopen", fake_urlopen):
            tracer._send_batch_remote(payloads, "test-key", "https://example.test")

        body = json.loads(gzip.decompress(captured["data"]))
        assert "traces" in body
        assert len(body["traces"]) == 2
        assert body["traces"][0]["id"] == "t1"
        assert body["traces"][1]["id"] == "t2"

    def test_gzip_header_set(self):
        captured = {}
        class FakeReq:
            def __init__(self, url, data, headers, method):
                captured["headers"] = headers
        with patch("swarmtrace.adapters.http_transport.Request", FakeReq), \
             patch("swarmtrace.adapters.http_transport.urlopen", lambda req, timeout: None):
            tracer._send_batch_remote([{"id": "t1"}], "k", "https://x.test")
        assert captured["headers"]["Content-Encoding"] == "gzip"
        assert captured["headers"]["Content-Type"] == "application/json"
        assert captured["headers"]["X-API-Key"] == "k"

    def test_body_is_gzip_compressed(self):
        captured = {}
        class FakeReq:
            def __init__(self, url, data, headers, method):
                captured["data"] = data
        with patch("swarmtrace.adapters.http_transport.Request", FakeReq), \
             patch("swarmtrace.adapters.http_transport.urlopen", lambda req, timeout: None):
            tracer._send_batch_remote(
                [{"id": "t1", "output": "x" * 1000}], "k", "https://x.test",
            )
        assert captured["data"][0:2] == b"\x1f\x8b"
        decompressed = gzip.decompress(captured["data"])
        parsed = json.loads(decompressed)
        assert parsed["traces"][0]["id"] == "t1"

    def test_compression_shrinks_repetitive_payload(self):
        captured = {}
        class FakeReq:
            def __init__(self, url, data, headers, method):
                captured["data"] = data
        payloads = [
            {"id": f"t{i}", "output": "the quick brown fox " * 200}
            for i in range(20)
        ]
        raw_bytes = json.dumps({"traces": payloads}).encode()
        with patch("swarmtrace.adapters.http_transport.Request", FakeReq), \
             patch("swarmtrace.adapters.http_transport.urlopen", lambda req, timeout: None):
            tracer._send_batch_remote(payloads, "k", "https://x.test")
        compressed = captured["data"]
        assert len(compressed) < len(raw_bytes) / 3


# --------------------------------------------------------------------------
# Sender — end-to-end batch flush + sync flag
# --------------------------------------------------------------------------

class TestWorkerBatchFlush:
    def test_batch_size_triggers_flush(self, fresh_storage):
        """20 traces → one batch POST, all 20 marked synced=1."""
        transport = FakeTransport()
        s = _sender(transport, fresh_storage)
        for i in range(20):
            s._queue.put_nowait({
                "id": f"t{i}", "function": "f", "timestamp": "2026-01-01T00:00:00Z",
            })
        batch = s.drain_batch(max_items=20, timeout=0.5)
        for payload in batch:
            fresh_storage.save_trace(
                id_=payload["id"], parent_id=None, function="f",
                args="()", output="out", latency_sec=0.1, error=None,
                timestamp="2026-01-01T00:00:00+00:00", input_tokens=0,
                output_tokens=0, cost_usd=0.0, kind="agent",
                agent_id=payload["id"], agent_name="f",
            )
        assert s._send_with_retries(batch, "test-key", "https://example.test") is True
        for payload in batch:
            s._repository.mark_synced(payload["id"])

        assert len(transport.batches) == 1
        assert len(transport.batches[0]) == 20
        for i in range(20):
            row = fresh_storage.get_by_id(f"t{i}")
            assert row is not None
            assert row["synced"] == 1

    def test_time_threshold_triggers_flush(self, fresh_storage):
        """A partial batch (3 < 20) still gets sent."""
        transport = FakeTransport()
        s = _sender(transport, fresh_storage)
        for i in range(3):
            s._queue.put_nowait({"id": f"t{i}", "function": "f"})
        batch = s.drain_batch(max_items=20, timeout=0.3)
        assert len(batch) == 3
        assert s._send_with_retries(batch, "test-key", "https://example.test") is True

        assert len(transport.batches) == 1
        assert len(transport.batches[0]) == 3

    def test_failed_batch_leaves_all_rows_unsynced(self, fresh_storage):
        """3 retries exhausted → every row stays synced=0 (resync picks them up)."""
        for i in range(3):
            fresh_storage.save_trace(
                id_=f"t{i}", parent_id=None, function="f",
                args="()", output="out", latency_sec=0.1, error=None,
                timestamp="2026-01-01T00:00:00+00:00", input_tokens=0,
                output_tokens=0, cost_usd=0.0, kind="agent",
                agent_id=f"t{i}", agent_name="f",
            )
        transport = FakeTransport(raise_on=Exception("endpoint down"))
        s = _sender(transport, fresh_storage)
        batch = [{"id": f"t{i}"} for i in range(3)]
        sent_ok = s._send_with_retries(batch, "test-key", "https://example.test")

        assert sent_ok is False
        for i in range(3):
            assert fresh_storage.get_by_id(f"t{i}")["synced"] == 0

    def test_successful_batch_marks_all_synced(self, fresh_storage):
        """Confirmed success → every row marked synced=1."""
        for i in range(5):
            fresh_storage.save_trace(
                id_=f"t{i}", parent_id=None, function="f",
                args="()", output="out", latency_sec=0.1, error=None,
                timestamp="2026-01-01T00:00:00+00:00", input_tokens=0,
                output_tokens=0, cost_usd=0.0, kind="agent",
                agent_id=f"t{i}", agent_name="f",
            )
        transport = FakeTransport()
        s = _sender(transport, fresh_storage)
        batch = [{"id": f"t{i}"} for i in range(5)]
        assert s._send_with_retries(batch, "test-key", "https://example.test") is True
        for p in batch:
            s._repository.mark_synced(p["id"])

        for i in range(5):
            assert fresh_storage.get_by_id(f"t{i}")["synced"] == 1

    def test_session_id_preserved_through_batch(self, fresh_storage):
        """session_id survives the batch round-trip."""
        captured = {}
        class FakeReq:
            def __init__(self, url, data, headers, method):
                captured["data"] = data
        with patch("swarmtrace.adapters.http_transport.Request", FakeReq), \
             patch("swarmtrace.adapters.http_transport.urlopen", lambda req, timeout: None):
            batch = [
                {"id": "t1", "session_id": "thread-42", "function": "f",
                 "timestamp": "2026-01-01T00:00:00Z"},
                {"id": "t2", "session_id": "thread-42", "function": "f",
                 "timestamp": "2026-01-01T00:00:01Z"},
                {"id": "t3", "session_id": None, "function": "g",
                 "timestamp": "2026-01-01T00:00:02Z"},
            ]
            tracer._send_batch_remote(batch, "k", "https://x.test")
        body = json.loads(gzip.decompress(captured["data"]))
        assert body["traces"][0]["session_id"] == "thread-42"
        assert body["traces"][1]["session_id"] == "thread-42"
        assert body["traces"][2].get("session_id") is None


# --------------------------------------------------------------------------
# resync still uses single-object path (not batch)
# --------------------------------------------------------------------------

class TestResyncStillSingleObject:
    """resync sends one row at a time via the transport's send_single, NOT via
    the batch send_batch path. Phase 1 routes resync through the Runtime seam."""

    def test_resync_uses_send_single_not_batch(self, fake_runtime):
        from datetime import datetime, timezone

        from swarmtrace.runtime import resync as runtime_resync
        from swarmtrace.span_model import SpanRecord

        span = SpanRecord(
            span_id="t1", parent_span_id=None, name="f", kind="agent",
            start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
            latency_sec=0.1, args="()", output="out", error=None,
            input_tokens=0, output_tokens=0, cost_usd=0.0,
            agent_id="t1", agent_name="f",
        )
        fake_runtime.repository.save(span)

        attempted, succeeded, failed = runtime_resync(batch_size=10, retries=1)
        assert (attempted, succeeded, failed) == (1, 1, 0)
        assert len(fake_runtime.transport.singles) == 1
        assert fake_runtime.transport.batches == []


# --------------------------------------------------------------------------
# Sender.stop — deterministic worker shutdown
#
# The worker used to loop forever with no exit path. Anything that tears down
# process state underneath it (a test rotating the SQLite DB, an embedder
# swapping runtimes) left a live thread writing through a connection the
# caller was about to close — a use-after-free that segfaults the interpreter.
# --------------------------------------------------------------------------

class TestSenderStop:
    def test_stop_joins_the_worker_thread(self):
        sender = _sender(FakeTransport(), _NullRepo(), batch_flush_timeout=0.02)
        sender.start()
        assert sender._thread is not None and sender._thread.is_alive()

        assert sender.stop(timeout=5.0) is True
        assert sender._thread is None
        assert sender._started is False

    def test_stop_is_safe_when_never_started(self):
        sender = _sender(FakeTransport(), _NullRepo(), batch_flush_timeout=0.02)
        assert sender.stop(timeout=1.0) is True

    def test_stop_drains_what_it_already_picked_up(self):
        """A batch already in flight is still delivered before the worker exits."""
        transport = FakeTransport()
        sender = _sender(transport, _NullRepo(), batch_flush_timeout=0.02)
        sender.enqueue({"id": "a"})

        deadline = time.time() + 5.0
        while time.time() < deadline and not transport.batches:
            time.sleep(0.01)

        assert sender.stop(timeout=5.0) is True
        assert [p["id"] for batch in transport.batches for p in batch] == ["a"]

    def test_restart_works_after_a_stop_that_timed_out(self):
        """A stop() whose join times out must not wedge the sender forever.

        The worker can still be inside a transport call when the timeout
        expires; it exits later, once it sees the stop flag. stop() can only
        tidy up state when its own join succeeded, so without authoritative
        worker-exit cleanup `_started` stayed True, `start()` short-circuited,
        and every subsequent payload was queued and silently never delivered.
        """
        release = threading.Event()

        class SlowTransport:
            def __init__(self):
                self.batches = []

            def send_batch(self, payloads, key, url):
                release.wait(10)          # outlives the stop timeout below
                self.batches.append(list(payloads))

        slow = SlowTransport()
        sender = _sender(slow, _NullRepo(), batch_flush_timeout=0.02)
        sender.enqueue({"id": "in-flight"})

        deadline = time.time() + 5.0
        while time.time() < deadline and not sender._queue.empty():
            time.sleep(0.01)              # wait until the worker has the batch

        assert sender.stop(timeout=0.1) is False, "expected the join to time out"
        release.set()

        deadline = time.time() + 5.0      # worker notices the flag and exits
        while time.time() < deadline and sender._started:
            time.sleep(0.01)
        assert sender._started is False, "worker exit did not repair lifecycle state"

        fresh = FakeTransport()
        sender._transport = fresh
        sender.enqueue({"id": "after-timeout-stop"})
        deadline = time.time() + 5.0
        while time.time() < deadline and not fresh.batches:
            time.sleep(0.01)
        sender.stop(timeout=5.0)
        assert [p["id"] for b in fresh.batches for p in b] == ["after-timeout-stop"]

    def test_stop_racing_start_never_leaves_a_workerless_started_sender(self, monkeypatch):
        """`_started=True` must always imply a live worker.

        start() used to publish `_started` AFTER launching the thread while
        stop() took no lock at all, so a stop landing in that window cleared
        the state and start() then re-set `_started=True` with `_thread=None`
        — a sender that accepts payloads forever and delivers none. The window
        is two bytecodes wide, so it is never hit by chance; widening thread
        startup makes the interleaving deterministic.
        """
        real_start = threading.Thread.start

        def slow_start(self):
            real_start(self)
            if self.name.startswith("race-sender"):
                time.sleep(0.05)
        monkeypatch.setattr(threading.Thread, "start", slow_start)

        sender = _sender(
            FakeTransport(), _NullRepo(),
            batch_flush_timeout=0.001, thread_name="race-sender",
        )
        starter = threading.Thread(target=sender.start)
        starter.start()
        time.sleep(0.02)                  # land inside the widened window
        sender.stop(timeout=1.0)
        starter.join()
        time.sleep(0.1)

        alive = sender._thread is not None and sender._thread.is_alive()
        assert not (sender._started and not alive), (
            "sender reports started with no live worker — payloads would be "
            "queued and never delivered"
        )
        sender.stop(timeout=5.0)

    def test_start_after_stop_brings_the_worker_back(self):
        """stop() must not permanently disable the sender."""
        transport = FakeTransport()
        sender = _sender(transport, _NullRepo(), batch_flush_timeout=0.02)
        sender.start()
        assert sender.stop(timeout=5.0) is True

        sender.enqueue({"id": "after-restart"})
        deadline = time.time() + 5.0
        while time.time() < deadline and not transport.batches:
            time.sleep(0.01)
        assert sender.stop(timeout=5.0) is True
        assert [p["id"] for batch in transport.batches for p in batch] == ["after-restart"]
