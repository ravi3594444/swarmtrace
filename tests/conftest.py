"""Shared fixtures."""

from __future__ import annotations

import pytest

from swarmtrace import runtime as runtime_module
from swarmtrace.runtime import Runtime
from tests._fakes import FakeRepository, FakeTransport


@pytest.fixture
def fake_runtime(monkeypatch):
    """Swap the process runtime for an in-memory repository + transport."""
    repository = FakeRepository()
    transport = FakeTransport()
    rt = Runtime(repository, transport, lambda: ("test-key", "https://example.test"))
    monkeypatch.setattr(runtime_module, "_runtime", rt)
    return rt
