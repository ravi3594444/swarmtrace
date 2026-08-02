"""
Regression tests for the regression.py score_similarity() crash bug and the
dashboard reporting path.

Part 1 — the crash bug
----------------------
Bug: `score = llm(prompt).strip()` and `float(score)` shared one try, with
`except ValueError` referencing `score` to log a friendly warning. If the
user-supplied llm callable raised ValueError before `score` was ever
assigned (network/SDK error, bad args, etc.), the except block itself threw
UnboundLocalError — uncaught by the sibling `except Exception` — crashing
compare() entirely and defeating the documented "never crash, default to
0.5" guarantee.

Fix: the llm() call and the float parse are now in two separate try/except
blocks, so the parsing except can never reference a value the call-failure
except already returned out of.

Part 2 — dashboard reporting (PRD §17: expose regression via an API route)
--------------------------------------------------------------------------
compare(..., report_to_dashboard=True) uploads the run to
{endpoint}/api/regression. The report is best-effort: it must never raise
or change compare()'s return value, and unconfigured/unsafe endpoints must
skip the upload entirely.
"""

import json

import swarmtrace.regression as regression


def test_llm_raising_value_error_falls_back_to_neutral():
    """The exact crash scenario: llm() itself raises ValueError before any
    score is assigned.
    """
    def broken_llm(prompt):
        raise ValueError("simulated SDK error")

    assert regression.score_similarity("a", "b", llm=broken_llm) == 0.5


def test_llm_raising_other_exception_falls_back_to_neutral():
    def broken_llm(prompt):
        raise ConnectionError("network down")

    assert regression.score_similarity("a", "b", llm=broken_llm) == 0.5


def test_non_numeric_output_falls_back_to_neutral():
    assert regression.score_similarity("a", "b", llm=lambda p: "not a number") == 0.5


def test_none_output_falls_back_to_neutral():
    assert regression.score_similarity("a", "b", llm=lambda p: None) == 0.5


def test_valid_numeric_output_is_used_and_clamped():
    assert regression.score_similarity("a", "b", llm=lambda p: "0.75") == 0.75
    assert regression.score_similarity("a", "b", llm=lambda p: "5") == 1.0     # clamped
    assert regression.score_similarity("a", "b", llm=lambda p: "-3") == 0.0    # clamped


def test_compare_does_not_crash_when_scoring_fails(monkeypatch):
    """End-to-end: a broken scorer must not blow up compare()."""
    def broken_llm(prompt):
        raise ValueError("simulated SDK error")

    def fake_func(input_text, prompt):
        return f"{prompt}:{input_text}"

    regressions = regression.compare(
        fake_func,
        inputs=["hello"],
        version_a_prompt="v1",
        version_b_prompt="v2",
        llm=broken_llm,
    )
    # similarity defaults to 0.5, threshold is 0.6 -> counts as a regression,
    # but the key thing is it ran at all instead of crashing.
    assert regressions == 1


# ── Dashboard reporting (PRD §17) ────────────────────────────────────────────

class FakeResponse:
    """Minimal urllib response stand-in supporting `with urlopen(...)`."""

    def __init__(self, status=204):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _capture_urlopen(monkeypatch, resp=None):
    """Patch regression.urlopen, recording every Request made."""
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append((req, timeout))
        if isinstance(resp, Exception):
            raise resp
        return resp if resp is not None else FakeResponse()

    monkeypatch.setattr(regression, "urlopen", fake_urlopen)
    return calls


def _configure_env(monkeypatch):
    monkeypatch.setenv("SWARMTRACE_API_KEY", "test-key-123")
    monkeypatch.setenv("SWARMTRACE_ENDPOINT", "https://swarmtrace.example.com")


def test_report_run_posts_to_dashboard_endpoint(monkeypatch):
    _configure_env(monkeypatch)
    calls = _capture_urlopen(monkeypatch)

    ok = regression.report_run(
        run_id="run-abc",
        name="emoji test",
        threshold=0.6,
        version_a_prompt="You are helpful.",
        version_b_prompt="Reply in emojis.",
        inputs_count=1,
        regressions_count=1,
        duration_sec=3.14,
        results=[{
            "input": "What is ML?",
            "output_a": "Machine learning is a field…",
            "output_b": "🤖",
            "latency_a_sec": 1.1,
            "latency_b_sec": 1.4,
            "similarity": 0.12,
        }],
    )

    assert ok is True
    assert len(calls) == 1
    req, timeout = calls[0]
    assert timeout == 10
    assert req.full_url == "https://swarmtrace.example.com/api/regression"
    assert req.get_method() == "POST"
    # urllib title-cases header names (X-api-key); HTTP headers are
    # case-insensitive so the wire format is fine — same as http_transport.
    assert req.headers["X-api-key"] == "test-key-123"
    assert req.headers["Content-type"] == "application/json"

    body = json.loads(req.data.decode())
    assert body["run_id"] == "run-abc"
    assert body["name"] == "emoji test"
    assert body["threshold"] == 0.6
    assert body["inputs_count"] == 1
    assert body["regressions_count"] == 1
    assert body["duration_sec"] == 3.14
    assert body["results"][0]["similarity"] == 0.12
    assert body["results"][0]["latency_a_sec"] == 1.1


def test_report_run_skips_when_not_configured(monkeypatch):
    monkeypatch.delenv("SWARMTRACE_API_KEY", raising=False)
    monkeypatch.delenv("SWARMTRACE_ENDPOINT", raising=False)
    calls = _capture_urlopen(monkeypatch)

    ok = regression.report_run(
        inputs_count=0, regressions_count=0, duration_sec=0.0, results=[],
    )

    assert ok is False
    assert calls == []  # nothing was ever sent


def test_report_run_never_raises_on_network_failure(monkeypatch):
    _configure_env(monkeypatch)
    _capture_urlopen(monkeypatch, resp=ConnectionError("network down"))

    ok = regression.report_run(
        inputs_count=1, regressions_count=0, duration_sec=1.0,
        results=[{"input": "x", "similarity": 0.9}],
    )
    assert ok is False


def test_report_run_returns_false_on_http_error(monkeypatch):
    _configure_env(monkeypatch)
    _capture_urlopen(monkeypatch, resp=FakeResponse(status=401))

    ok = regression.report_run(
        inputs_count=0, regressions_count=0, duration_sec=0.0, results=[],
    )
    assert ok is False


def test_report_run_redacts_and_truncates_text(monkeypatch):
    _configure_env(monkeypatch)
    calls = _capture_urlopen(monkeypatch)

    long_text = "a" * 40000
    regression.report_run(
        inputs_count=1, regressions_count=0, duration_sec=1.0,
        version_a_prompt="email admin@example.com",
        results=[{
            "input": long_text,
            "output_a": "token sk-abcdefghijklmnopqrstuvwxyz123456789012",
            "similarity": 0.5,
        }],
    )

    body = json.loads(calls[0][0].data.decode())
    # Truncated to the dashboard cap (32000), not 40000.
    assert len(body["results"][0]["input"]) == regression.MAX_TEXT_LEN
    # PII redacted before transmission (FR-7: redaction before remote send).
    assert "admin@example.com" not in body["version_a_prompt"]
    assert "sk-abcdefghijklmnopqrstuvwxyz123456789012" not in body["results"][0]["output_a"]
    assert "[REDACTED]" in body["results"][0]["output_a"]


def test_report_run_generates_fresh_run_id_per_call(monkeypatch):
    _configure_env(monkeypatch)
    calls = _capture_urlopen(monkeypatch)

    regression.report_run(inputs_count=0, regressions_count=0, duration_sec=0.0, results=[])
    regression.report_run(inputs_count=0, regressions_count=0, duration_sec=0.0, results=[])

    id1 = json.loads(calls[0][0].data.decode())["run_id"]
    id2 = json.loads(calls[1][0].data.decode())["run_id"]
    assert id1 != id2
    # Hex run ids satisfy the server's [A-Za-z0-9_-]{1,64} rule.
    import re
    assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", id1)


def test_compare_report_to_dashboard_posts_run_and_keeps_return(monkeypatch):
    """compare(..., report_to_dashboard=True) posts a full run and still
    returns the regression count; a failing upload doesn't change that."""
    _configure_env(monkeypatch)
    calls = _capture_urlopen(monkeypatch)

    def fake_func(input_text, prompt):
        return f"{prompt}:{input_text}"

    regressions = regression.compare(
        fake_func,
        inputs=["hello", "world"],
        version_a_prompt="v1",
        version_b_prompt="v2",
        threshold=0.6,
        llm=lambda p: "0.1",  # everything scores below threshold
        report_to_dashboard=True,
        run_name="ci-run",
    )

    assert regressions == 2
    assert len(calls) == 1
    body = json.loads(calls[0][0].data.decode())
    assert body["name"] == "ci-run"
    assert body["inputs_count"] == 2
    assert body["regressions_count"] == 2
    assert len(body["results"]) == 2
    assert body["results"][0]["input"] == "hello"
    assert body["results"][0]["similarity"] == 0.1


def test_compare_report_failure_does_not_break_run(monkeypatch):
    _configure_env(monkeypatch)
    _capture_urlopen(monkeypatch, resp=ConnectionError("network down"))

    def fake_func(input_text, prompt):
        return "same output"

    # Must not raise even though the upload fails.
    regressions = regression.compare(
        fake_func,
        inputs=["hello"],
        version_a_prompt="v1",
        version_b_prompt="v2",
        llm=lambda p: "0.9",
        report_to_dashboard=True,
    )
    assert regressions == 0  # 0.9 >= 0.6 -> no regression; run still completed


def test_compare_without_report_makes_no_network_calls(monkeypatch):
    _configure_env(monkeypatch)
    calls = _capture_urlopen(monkeypatch)

    regression.compare(
        lambda i, p: "out",
        inputs=["hello"],
        version_a_prompt="v1",
        version_b_prompt="v2",
        llm=lambda p: "0.9",
    )
    assert calls == []

