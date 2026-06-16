"""
Field-of-View (FOV) — live activity monitor for AI agents.

Patches Playwright, OpenAI/Anthropic streams, requests/httpx,
and the filesystem so every agent action is surfaced in real time
on the SwarmTrace dashboard.  Zero changes to agent code required.

Usage::

    from tracely import init
    init(api_key="...", endpoint="...", fov=True)

    # or explicitly:
    from tracely.fov import patch_all
    patch_all()

What each patch captures
------------------------
* playwright   — every page action (goto/click/fill/…) + live screenshot
* streams      — OpenAI/Anthropic stream tokens as they arrive
* network      — requests / httpx HTTP calls with method, url, status, latency
* filesystem   — file reads/writes in the watched directory (watchdog)
"""

from __future__ import annotations

import base64
import functools
import json
import os
import queue
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

# ── context from tracer ──────────────────────────────────────────────────────
from tracely.tracer import _current_agent, _remote_config

# ── local event storage ──────────────────────────────────────────────────────
from tracely.storage import _get_conn, _lock as _storage_lock

# ---------------------------------------------------------------------------
# Local SQLite event table
# ---------------------------------------------------------------------------

_events_table_ready = False


def _ensure_events_table() -> None:
    global _events_table_ready
    if _events_table_ready:
        return
    with _storage_lock:
        conn = _get_conn()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agent_events (
                id           TEXT PRIMARY KEY,
                agent_id     TEXT NOT NULL,
                agent_name   TEXT,
                event_type   TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'info',
                data         TEXT,
                timestamp    TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_evts_agent "
            "ON agent_events(agent_id, timestamp DESC)"
        )
        conn.commit()
    _events_table_ready = True


def _save_event_local(event: dict) -> None:
    _ensure_events_table()
    try:
        with _storage_lock:
            conn = _get_conn()
            conn.execute(
                "INSERT OR REPLACE INTO agent_events "
                "(id, agent_id, agent_name, event_type, status, data, timestamp) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    event["id"],
                    event["agent_id"],
                    event.get("agent_name", ""),
                    event["event_type"],
                    event.get("status", "info"),
                    json.dumps(event.get("data", {})),
                    event["timestamp"],
                ),
            )
            conn.commit()
    except Exception as exc:
        print(f"[swarmtrace/fov] event save warning: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Remote event sender  (separate queue → /api/events)
# ---------------------------------------------------------------------------

_FOV_QUEUE: "queue.Queue[dict]" = queue.Queue(maxsize=500)
_fov_worker_lock = threading.Lock()
_fov_worker_started = False


def _send_event_remote(payload: dict, key: str, base_url: str) -> None:
    try:
        import urllib.request
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{base_url}/api/events",
            data=body,
            headers={"Content-Type": "application/json", "X-API-Key": key},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        print(f"[swarmtrace/fov] remote event warning: {exc}", file=sys.stderr)


def _fov_worker() -> None:
    while True:
        payload = _FOV_QUEUE.get()
        key, url = _remote_config()
        if key and url:
            _send_event_remote(payload, key, url.rstrip("/"))
        _FOV_QUEUE.task_done()


def _ensure_fov_worker() -> None:
    global _fov_worker_started
    if _fov_worker_started:
        return
    with _fov_worker_lock:
        if not _fov_worker_started:
            threading.Thread(
                target=_fov_worker, daemon=True, name="swarmtrace-fov-sender"
            ).start()
            _fov_worker_started = True


def _enqueue_fov_event(event: dict) -> None:
    key, url = _remote_config()
    if not (key and url):
        return
    _ensure_fov_worker()
    try:
        _FOV_QUEUE.put_nowait(event)
    except queue.Full:
        try:
            _FOV_QUEUE.get_nowait()
            _FOV_QUEUE.put_nowait(event)
        except Exception:
            pass


def _save_event(event: dict) -> None:
    """Save event to local SQLite and enqueue for remote ingest."""
    _save_event_local(event)
    _enqueue_fov_event(event)


def _mk_event(event_type: str, status: str, data: dict) -> dict:
    """Build an event dict attributed to the current agent context."""
    agent = _current_agent()
    if agent is None:
        return {}
    agent_id, agent_name = agent
    return {
        "id": uuid.uuid4().hex,
        "agent_id": agent_id,
        "agent_name": agent_name,
        "event_type": event_type,
        "status": status,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Screenshot helper
# ---------------------------------------------------------------------------

def _resize_jpeg(raw: bytes, max_width: int = 800) -> bytes:
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(raw))
        if img.width > max_width:
            h = int(img.height * max_width / img.width)
            img = img.resize((max_width, h), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=55)
        return buf.getvalue()
    except ImportError:
        return raw


def _to_data_uri(raw: bytes) -> str:
    raw = _resize_jpeg(raw)
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


def _screenshot_sync(page) -> str:
    try:
        return _to_data_uri(page.screenshot(type="jpeg", quality=50))
    except Exception:
        return ""


async def _screenshot_async(page) -> str:
    try:
        return _to_data_uri(await page.screenshot(type="jpeg", quality=50))
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# 1. Playwright patch
# ---------------------------------------------------------------------------

_PLAYWRIGHT_PATCHED = False

_PAGE_METHODS = [
    "goto", "click", "fill", "type", "press",
    "select_option", "check", "uncheck", "tap",
    "dblclick", "hover", "drag_and_drop",
]


def _wrap_sync_method(name: str, original):
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):
        if _current_agent() is None:
            return original(self, *args, **kwargs)
        ev = _mk_event("browser", "started", {
            "method": name,
            "args": [str(a)[:200] for a in args],
        })
        if ev:
            _save_event(ev)
        try:
            result = original(self, *args, **kwargs)
            data = {
                "method": name,
                "args": [str(a)[:200] for a in args],
                "url": getattr(self, "url", ""),
                "screenshot": _screenshot_sync(self),
            }
            ev2 = _mk_event("browser", "done", data)
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": str(exc)})
            if ev3:
                _save_event(ev3)
            raise
    wrapper._swarmtrace_patched = True
    return wrapper


def _wrap_async_method(name: str, original):
    @functools.wraps(original)
    async def wrapper(self, *args, **kwargs):
        if _current_agent() is None:
            return await original(self, *args, **kwargs)
        ev = _mk_event("browser", "started", {"method": name, "args": [str(a)[:200] for a in args]})
        if ev:
            _save_event(ev)
        try:
            result = await original(self, *args, **kwargs)
            data = {
                "method": name,
                "args": [str(a)[:200] for a in args],
                "url": getattr(self, "url", ""),
                "screenshot": await _screenshot_async(self),
            }
            ev2 = _mk_event("browser", "done", data)
            if ev2:
                _save_event(ev2)
            return result
        except Exception as exc:
            ev3 = _mk_event("browser", "error", {"method": name, "error": str(exc)})
            if ev3:
                _save_event(ev3)
            raise
    wrapper._swarmtrace_patched = True
    return wrapper


def patch_playwright() -> bool:
    global _PLAYWRIGHT_PATCHED
    if _PLAYWRIGHT_PATCHED:
        return True
    patched = False
    try:
        from playwright.sync_api import Page as SP
        for m in _PAGE_METHODS:
            orig = getattr(SP, m, None)
            if orig and not getattr(orig, "_swarmtrace_patched", False):
                setattr(SP, m, _wrap_sync_method(m, orig))
        patched = True
    except ImportError:
        pass
    try:
        from playwright.async_api import Page as AP
        for m in _PAGE_METHODS:
            orig = getattr(AP, m, None)
            if orig and not getattr(orig, "_swarmtrace_patched", False):
                setattr(AP, m, _wrap_async_method(m, orig))
        patched = True
    except ImportError:
        pass
    _PLAYWRIGHT_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 2. LLM stream patch  (OpenAI + Anthropic)
# ---------------------------------------------------------------------------

_STREAMS_PATCHED = False


class _StreamWrapper:
    """Wraps an OpenAI sync stream, firing token events per chunk."""
    def __init__(self, stream, agent_id: str, agent_name: str):
        self._stream = stream
        self._agent_id = agent_id
        self._agent_name = agent_name
        self._buf: list[str] = []

    def __iter__(self):
        for chunk in self._stream:
            token = ""
            try:
                token = chunk.choices[0].delta.content or ""
            except Exception:
                pass
            if token:
                self._buf.append(token)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": self._agent_id,
                    "agent_name": self._agent_name,
                    "event_type": "llm_token",
                    "status": "streaming",
                    "data": {
                        "token": token,
                        "accumulated": "".join(self._buf)[-500:],
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            yield chunk

    def __enter__(self):
        if hasattr(self._stream, "__enter__"):
            self._stream.__enter__()
        return self

    def __exit__(self, *a):
        if hasattr(self._stream, "__exit__"):
            return self._stream.__exit__(*a)

    def __getattr__(self, name):
        return getattr(self._stream, name)


class _AsyncStreamWrapper:
    """Wraps an OpenAI async stream."""
    def __init__(self, stream, agent_id: str, agent_name: str):
        self._stream = stream
        self._agent_id = agent_id
        self._agent_name = agent_name
        self._buf: list[str] = []

    def __aiter__(self):
        return self._aiter()

    async def _aiter(self):
        async for chunk in self._stream:
            token = ""
            try:
                token = chunk.choices[0].delta.content or ""
            except Exception:
                pass
            if token:
                self._buf.append(token)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": self._agent_id,
                    "agent_name": self._agent_name,
                    "event_type": "llm_token",
                    "status": "streaming",
                    "data": {
                        "token": token,
                        "accumulated": "".join(self._buf)[-500:],
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            yield chunk

    async def __aenter__(self):
        if hasattr(self._stream, "__aenter__"):
            await self._stream.__aenter__()
        return self

    async def __aexit__(self, *a):
        if hasattr(self._stream, "__aexit__"):
            return await self._stream.__aexit__(*a)

    def __getattr__(self, name):
        return getattr(self._stream, name)


def patch_streams() -> bool:
    global _STREAMS_PATCHED
    if _STREAMS_PATCHED:
        return True
    patched = False
    # OpenAI
    try:
        import openai.resources.chat.completions as _cc
        _orig = _cc.Completions.create

        @functools.wraps(_orig)
        def _patched_create(self, *args, **kwargs):
            result = _orig(self, *args, **kwargs)
            agent = _current_agent()
            if agent and kwargs.get("stream", False):
                aid, aname = agent
                return _StreamWrapper(result, aid, aname)
            return result

        _cc.Completions.create = _patched_create
        patched = True
    except Exception:
        pass

    # OpenAI async
    try:
        import openai.resources.chat.completions as _cc
        _aorig = _cc.AsyncCompletions.create

        @functools.wraps(_aorig)
        async def _async_patched(self, *args, **kwargs):
            result = await _aorig(self, *args, **kwargs)
            agent = _current_agent()
            if agent and kwargs.get("stream", False):
                aid, aname = agent
                return _AsyncStreamWrapper(result, aid, aname)
            return result

        _cc.AsyncCompletions.create = _async_patched
        patched = True
    except Exception:
        pass

    _STREAMS_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 3. Network patch  (requests + httpx)
# ---------------------------------------------------------------------------

_NETWORK_PATCHED = False

# Skip these to avoid double-counting SDK-wrapped LLM calls
_SKIP_HOSTS = {
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.groq.com",
}


def _skip_url(url: str) -> bool:
    return any(h in url for h in _SKIP_HOSTS)


def patch_network() -> bool:
    global _NETWORK_PATCHED
    if _NETWORK_PATCHED:
        return True
    patched = False

    # requests
    try:
        import requests
        _orig_req = requests.Session.request

        @functools.wraps(_orig_req)
        def _patched_req(self, method, url, **kwargs):
            agent = _current_agent()
            if agent is None or _skip_url(str(url)):
                return _orig_req(self, method, url, **kwargs)
            aid, aname = agent
            ts = datetime.now(timezone.utc).isoformat()
            t0 = time.perf_counter()
            try:
                resp = _orig_req(self, method, url, **kwargs)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "done",
                    "data": {
                        "method": method.upper(), "url": str(url)[:300],
                        "status_code": resp.status_code,
                        "latency_sec": round(time.perf_counter() - t0, 3),
                    },
                    "timestamp": ts,
                })
                return resp
            except Exception as exc:
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "error",
                    "data": {"method": method.upper(), "url": str(url)[:300], "error": str(exc)},
                    "timestamp": ts,
                })
                raise

        requests.Session.request = _patched_req
        patched = True
    except ImportError:
        pass

    # httpx
    try:
        import httpx
        _orig_send = httpx.Client.send

        @functools.wraps(_orig_send)
        def _patched_send(self, request, **kwargs):
            agent = _current_agent()
            url = str(request.url)
            if agent is None or _skip_url(url):
                return _orig_send(self, request, **kwargs)
            aid, aname = agent
            ts = datetime.now(timezone.utc).isoformat()
            t0 = time.perf_counter()
            try:
                resp = _orig_send(self, request, **kwargs)
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "done",
                    "data": {
                        "method": request.method, "url": url[:300],
                        "status_code": resp.status_code,
                        "latency_sec": round(time.perf_counter() - t0, 3),
                    },
                    "timestamp": ts,
                })
                return resp
            except Exception as exc:
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "http", "status": "error",
                    "data": {"method": request.method, "url": url[:300], "error": str(exc)},
                    "timestamp": ts,
                })
                raise

        httpx.Client.send = _patched_send
        patched = True
    except ImportError:
        pass

    _NETWORK_PATCHED = True
    return patched


# ---------------------------------------------------------------------------
# 4. Filesystem watcher (watchdog)
# ---------------------------------------------------------------------------

_FS_PATCHED = False


def patch_filesystem(watch_dir: str = ".") -> bool:
    global _FS_PATCHED
    if _FS_PATCHED:
        return True
    try:
        from watchdog.observers import Observer
        from watchdog.events import FileSystemEventHandler

        class _Handler(FileSystemEventHandler):
            def _emit(self, action: str, path: str):
                # Skip noisy internals
                if any(x in path for x in (".tracely", "__pycache__", ".git", ".pyc")):
                    return
                agent = _current_agent()
                if agent is None:
                    return
                aid, aname = agent
                _save_event({
                    "id": uuid.uuid4().hex,
                    "agent_id": aid, "agent_name": aname,
                    "event_type": "file", "status": "info",
                    "data": {"action": action, "path": path[-200:]},
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })

            def on_modified(self, ev):
                if not ev.is_directory:
                    self._emit("modified", ev.src_path)

            def on_created(self, ev):
                if not ev.is_directory:
                    self._emit("created", ev.src_path)

        obs = Observer()
        obs.schedule(_Handler(), path=os.path.abspath(watch_dir), recursive=True)
        obs.daemon = True
        obs.start()
        _FS_PATCHED = True
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# patch_all — one call to activate everything
# ---------------------------------------------------------------------------

def patch_all(watch_dir: str = ".") -> dict:
    """
    Activate all FOV patches.

    Returns which patches are active::

        {"playwright": True, "streams": True, "network": True, "filesystem": False}

    ``filesystem=False`` means watchdog is not installed — all other patches
    work without it.  Install with ``pip install watchdog``.
    """
    results = {
        "playwright":  patch_playwright(),
        "streams":     patch_streams(),
        "network":     patch_network(),
        "filesystem":  patch_filesystem(watch_dir),
    }
    active = [k for k, v in results.items() if v]
    print(f"[swarmtrace/fov] patches active: {', '.join(active) or 'none'}", file=sys.stderr)
    return results


def get_events(agent_id: str, limit: int = 100) -> list:
    """Return recent FOV events for a given agent_id."""
    _ensure_events_table()
    try:
        with _storage_lock:
            conn = _get_conn()
            import sqlite3
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM agent_events WHERE agent_id=? "
                "ORDER BY timestamp DESC LIMIT ?",
                (agent_id, limit),
            ).fetchall()
            conn.row_factory = None
            return [dict(r) for r in rows]
    except Exception:
        return []
