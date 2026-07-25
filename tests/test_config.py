"""Tests for the shared configuration layer.

The remote endpoint validation used to live in tracer.py. The architecture now
keeps it in swarmtrace.config so runtime, FOV, alerts, and other adapters do not
need to import tracer internals.
"""

import pytest

import swarmtrace.config as config
import swarmtrace.tracer as tracer


@pytest.fixture(autouse=True)
def clean_config_state():
    old_key = getattr(tracer, "_api_key", None)
    old_endpoint = getattr(tracer, "_endpoint", None)
    config.clear_remote_config()
    tracer._api_key = None
    tracer._endpoint = None
    try:
        yield
    finally:
        config.clear_remote_config()
        tracer._api_key = old_key
        tracer._endpoint = old_endpoint


# Keep a local compatibility copy so old imports from tracer stay locked to the
# same behavior while new code imports from config directly.

def test_config_normalizes_endpoint_from_environment(monkeypatch):
    config.clear_remote_config()
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", " https://example.test/API/ ")

    assert config.remote_config() == ("sk_test", "https://example.test")


def test_config_rejects_plaintext_non_localhost(monkeypatch):
    config.clear_remote_config()
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "http://example.test")

    key, endpoint = config.remote_config()

    assert key == "sk_test"
    assert endpoint == ""


def test_configure_remote_overrides_environment(monkeypatch):
    config.clear_remote_config()
    monkeypatch.setenv("SWARMTRACE_API_KEY", "env_key")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://env.example")

    config.configure_remote(api_key="init_key", endpoint="https://init.example/api")

    assert config.remote_config() == ("init_key", "https://init.example")


def test_tracer_private_compatibility_wrappers_delegate_to_config(monkeypatch):
    config.clear_remote_config()
    monkeypatch.setattr(tracer, "_api_key", None, raising=False)
    monkeypatch.setattr(tracer, "_endpoint", None, raising=False)
    monkeypatch.setenv("SWARMTRACE_API_KEY", "sk_test")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://wrapper.example/api")

    assert tracer._remote_config() == config.remote_config()
    assert tracer._normalize_base_url("https://wrapper.example/API/") == "https://wrapper.example"
    assert tracer._validate_endpoint_scheme("https://wrapper.example") == (True, "")
