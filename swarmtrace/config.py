"""Process-wide runtime configuration for SwarmTrace.

This module is the architectural home for configuration that must be shared by
multiple layers: the public SDK façade (``tracer.py``), the core runtime, FOV
live events, alerts, and future delivery adapters. Keeping this logic here
prevents optional modules from importing private tracer internals just to find
out where remote telemetry should be sent.

The environment is still read lazily so applications can load ``.env`` files or
set ``os.environ`` after importing SwarmTrace. Explicit values passed to
``swarmtrace.init(api_key=..., endpoint=...)`` are stored with
:func:`configure_remote` and override environment variables.
"""

from __future__ import annotations

import logging
import os
from typing import Optional, Tuple
from urllib.parse import urlparse

_log = logging.getLogger("swarmtrace")

_api_key: Optional[str] = None
_endpoint: Optional[str] = None


def configure_remote(
    *,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
) -> None:
    """Set process-local remote ingest configuration.

    ``None`` means "leave the existing value unchanged". This mirrors
    ``swarmtrace.init`` so callers can update just one setting without
    accidentally clearing the other. Environment variables remain the fallback
    when a setting has never been configured explicitly.
    """
    global _api_key, _endpoint
    if api_key is not None:
        _api_key = api_key
    if endpoint is not None:
        _endpoint = endpoint


def clear_remote_config() -> None:
    """Clear explicit remote configuration and fall back to environment vars.

    Intended primarily for tests and custom embedding scenarios.
    """
    global _api_key, _endpoint
    _api_key = None
    _endpoint = None


def remote_config() -> Tuple[str, str]:
    """Return ``(api_key, normalized_endpoint)`` for remote ingest.

    If no endpoint is configured, the endpoint component is ``""``. If an
    unsafe endpoint is configured (for example plaintext HTTP to a non-localhost
    host), the endpoint component is also ``""`` and a warning is logged; this
    makes senders skip remote delivery rather than leaking the API key.
    """
    return resolve_remote_config()


def resolve_remote_config(
    *,
    api_key_override: Optional[str] = None,
    endpoint_override: Optional[str] = None,
) -> Tuple[str, str]:
    """Resolve remote config with optional explicit overrides.

    This helper exists so ``tracer.py`` can preserve its historical private
    ``_api_key`` / ``_endpoint`` compatibility aliases while delegating the
    actual validation and normalization rules to this module.
    """
    key = (
        api_key_override
        if api_key_override is not None
        else (_api_key if _api_key is not None else os.environ.get("SWARMTRACE_API_KEY", ""))
    )
    raw_url = (
        endpoint_override
        if endpoint_override is not None
        else (_endpoint if _endpoint is not None else os.environ.get("SWARMTRACE_ENDPOINT", ""))
    )
    ok, reason = validate_endpoint_scheme(raw_url)
    if not ok:
        _log.warning("SWARMTRACE_ENDPOINT insecure — refusing to send traces: %s", reason)
        return key, ""
    return key, normalize_base_url(raw_url)


def validate_endpoint_scheme(url: str) -> Tuple[bool, str]:
    """Check whether *url* is safe to send the SwarmTrace API key to.

    Returns ``(ok, reason)``. ``ok=True`` means safe (or empty — no endpoint
    configured). ``ok=False`` means the URL would leak the API key or is not an
    HTTP(S) endpoint; ``reason`` is human-readable and suitable for logs.

    Rules:
      - Empty URL → ok (means no endpoint configured; worker will skip).
      - ``https://`` → ok (any host).
      - ``http://`` → ok only for ``localhost``, ``127.0.0.1``, ``::1``.
      - ``http://`` to anything else → rejected.
      - Any other scheme (``ftp://``, ``file://``, etc.) → rejected.
      - No scheme at all → rejected.
    """
    if not url:
        return True, ""

    parsed = urlparse(url)
    scheme = (parsed.scheme or "").lower()
    hostname = (parsed.hostname or "").lower()

    if scheme == "https":
        return True, ""

    if scheme == "http":
        if hostname in ("localhost", "127.0.0.1", "::1"):
            return True, ""
        return False, (
            f"http:// to non-localhost host '{hostname}' would send the "
            "API key over plaintext HTTP. Use https://, or set "
            "SWARMTRACE_ENDPOINT=http://localhost:... for local dev."
        )

    return False, (
        f"unsupported scheme '{scheme or '(none)'}://' — only https:// "
        "(any host) and http:// (localhost only) are allowed."
    )


def normalize_base_url(url: str) -> str:
    """Normalize the dashboard/collector base URL.

    Users commonly configure any of these forms::

        https://app.example.com
        https://app.example.com/
        https://app.example.com/api
        https://app.example.com/api/

    Callers append their own route (``/api/ingest``, ``/api/events``, etc.), so
    this function strips surrounding whitespace, trailing slashes, and one
    trailing ``/api`` segment case-insensitively.
    """
    s = url.strip().rstrip("/")
    if s[-4:].casefold() == "/api":
        s = s[:-4].rstrip("/")
    return s


__all__ = [
    "clear_remote_config",
    "configure_remote",
    "normalize_base_url",
    "remote_config",
    "resolve_remote_config",
    "validate_endpoint_scheme",
]
