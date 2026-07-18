"""Shared test fixtures for the Phase 1 runtime seam."""

from __future__ import annotations

import pytest

from swarmtrace import runtime as runtime_module
from swarmtrace.runtime import Runtime
from tests._fakes import FakeRepository, FakeTransport


@pytest.fixture
def fake_runtime(monkeypatch):
    """Replace the process runtime with an in-memory fake repository + transport.

    Patches the runtime module's ``_runtime`` singleton so every caller of
    ``get_runtime()`` — whether it imported the function directly or via the
    module — receives the fake. This is what lets tests drop the old pattern
    of monkeypatching private ``tracer.py`` internals.
    """
    repository = FakeRepository()
    transport = FakeTransport()
    rt = Runtime(repository, transport, lambda: ("test-key", "https://example.test"))
    monkeypatch.setattr(runtime_module, "_runtime", rt)
    return rt
