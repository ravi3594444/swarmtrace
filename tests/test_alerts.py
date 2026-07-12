"""
Tests for the alert engine: rule evaluation, cooldown, persistence,
and webhook delivery. All external I/O is mocked out so the suite is
hermetic.
"""

import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

import swarmtrace.alerts as alerts
from swarmtrace.alerts import Alert, RuleConfig, RuleEngine


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh_alert_db(monkeypatch, tmp_path):
    """Redirect the alerts DB to a per-test temp file so tests are isolated."""
    db = tmp_path / "test_alerts.db"
    monkeypatch.setattr(alerts, "ALERT_DB_PATH", str(db))
    monkeypatch.setattr(alerts, "_conn", None)
    # Also wipe any cached engine/config from prior tests so order doesn't matter.
    alerts._reset_state_for_tests()
    yield str(db)


def _trace(
    agent_id: str = "agt-1",
    agent_name: str = "my_agent",
    cost: float = 0.0,
    latency: float = 0.5,
    error: str = None,
    function: str = "step",
    n: int = 1,
    within_window: bool = True,
) -> list:
    """
    Build synthetic TraceRow dicts matching swarmtrace.storage.TraceRow —
    one dict per row, keyed by column name (id, parent_id, function, args,
    output, latency_sec, error, timestamp, input_tokens, output_tokens,
    cost_usd, kind, agent_id, agent_name, ...), same shape get_all_traces()
    hands the rule engine in production.
    """
    rows = []
    base = datetime.now(timezone.utc)
    for i in range(n):
        ts = base if within_window else base.replace(year=base.year - 1)
        rows.append({
            "id": f"trace-{agent_id}-{i}",
            "parent_id": None,
            "function": function,
            "args": "()",
            "output": "ok",
            "latency_sec": latency,
            "error": error,
            "timestamp": ts.isoformat(),
            "input_tokens": 100,
            "output_tokens": 50,
            "cost_usd": cost,
            "kind": "agent",
            "agent_id": agent_id,
            "agent_name": agent_name,
        })
    return rows


# ---------------------------------------------------------------------------
# RuleConfig defaults
# ---------------------------------------------------------------------------

def test_rule_config_defaults_are_safe():
    cfg = RuleConfig()
    assert cfg.budget_usd == 5.0
    assert cfg.error_rate_threshold == 0.5
    assert cfg.latency_p95_sec == 30.0
    assert cfg.cooldown_seconds == 300
    assert "budget_breach" in cfg.enabled_rules
    assert "error_spike" in cfg.enabled_rules
    assert "latency_regression" in cfg.enabled_rules


# ---------------------------------------------------------------------------
# budget_breach
# ---------------------------------------------------------------------------

def test_budget_breach_fires_when_spend_exceeds_threshold():
    cfg = RuleConfig(budget_usd=5.0, window_minutes=60, cooldown_seconds=0)
    engine = RuleEngine(cfg)
    # 10 traces × $0.6 each = $6 (above $5)
    traces = _trace(agent_id="a1", cost=0.6, n=10)
    fired = engine.evaluate(traces)
    assert len(fired) == 1
    a = fired[0]
    assert a.rule == "budget_breach"
    assert a.severity == "warning"  # $6 is < 2× threshold ($10)
    assert a.agent_id == "a1"
    assert a.agent_name == "my_agent"
    assert "spent $6" in a.message


def test_budget_breach_escalates_to_critical_at_2x():
    cfg = RuleConfig(budget_usd=5.0, cooldown_seconds=0)
    engine = RuleEngine(cfg)
    # 25 × $0.5 = $12.5 → > 2× $5 → critical
    traces = _trace(agent_id="a1", cost=0.5, n=25)
    fired = engine.evaluate(traces)
    assert len(fired) == 1
    assert fired[0].severity == "critical"


def test_budget_breach_respects_window():
    """Traces older than ``window_minutes`` should not count toward the budget."""
    cfg = RuleConfig(budget_usd=5.0, window_minutes=60, cooldown_seconds=0)
    engine = RuleEngine(cfg)
    # 100 × $1 but ALL outside the 60-min window → no alert.
    traces = _trace(agent_id="a1", cost=1.0, n=100, within_window=False)
    assert engine.evaluate(traces) == []


def test_budget_breach_uses_cooldown():
    """The same (rule, agent) shouldn't fire twice within the cooldown window."""
    cfg = RuleConfig(budget_usd=5.0, cooldown_seconds=300)  # 5 min
    engine = RuleEngine(cfg)
    traces = _trace(agent_id="a1", cost=1.0, n=10)
    first  = engine.evaluate(traces)
    second = engine.evaluate(traces)
    assert len(first)  == 1
    assert len(second) == 0    # cooldown active


# ---------------------------------------------------------------------------
# error_spike
# ---------------------------------------------------------------------------

def test_error_spike_fires_when_rate_exceeds_threshold():
    cfg = RuleConfig(
        error_rate_threshold=0.5, min_traces=10, cooldown_seconds=0
    )
    engine = RuleEngine(cfg)
    # 10 traces, 7 errors → 70% > 50% threshold
    ok   = _trace(agent_id="a1", n=3)
    bad  = _trace(agent_id="a1", n=7, error="boom")
    fired = engine.evaluate(ok + bad)
    assert len(fired) == 1
    a = fired[0]
    assert a.rule == "error_spike"
    assert "70%" in a.message


def test_error_spike_critical_at_90_percent():
    cfg = RuleConfig(
        error_rate_threshold=0.5, min_traces=10, cooldown_seconds=0
    )
    engine = RuleEngine(cfg)
    ok  = _trace(agent_id="a1", n=1)
    bad = _trace(agent_id="a1", n=9, error="x")
    fired = engine.evaluate(ok + bad)
    assert len(fired) == 1
    assert fired[0].severity == "critical"


def test_error_spike_below_min_traces_no_alert():
    cfg = RuleConfig(
        error_rate_threshold=0.1, min_traces=50, cooldown_seconds=0
    )
    engine = RuleEngine(cfg)
    # 100% errors, but only 4 traces (< 50) → no alert.
    traces = _trace(agent_id="a1", n=4, error="x")
    assert engine.evaluate(traces) == []


# ---------------------------------------------------------------------------
# latency_regression
# ---------------------------------------------------------------------------

def test_latency_regression_fires_when_p95_exceeds_threshold():
    cfg = RuleConfig(latency_p95_sec=10.0, min_traces=20, cooldown_seconds=0)
    engine = RuleEngine(cfg)
    # 20 traces: 19 fast (0.5s), 1 slow (25s) → p95 = 25s > 10s threshold.
    traces = _trace(agent_id="a1", latency=0.5, n=19) + _trace(agent_id="a1", latency=25.0, n=1)
    fired = engine.evaluate(traces)
    assert len(fired) == 1
    a = fired[0]
    assert a.rule == "latency_regression"
    assert a.severity == "warning"
    assert "p95 latency 25.0s" in a.message


def test_latency_regression_no_alert_when_fast():
    cfg = RuleConfig(latency_p95_sec=10.0, min_traces=20, cooldown_seconds=0)
    engine = RuleEngine(cfg)
    traces = _trace(agent_id="a1", latency=1.0, n=20)
    assert engine.evaluate(traces) == []


# ---------------------------------------------------------------------------
# Empty / disabled cases
# ---------------------------------------------------------------------------

def test_empty_traces_returns_no_alerts():
    engine = RuleEngine()
    assert engine.evaluate([]) == []


def test_disabling_a_rule_suppresses_its_alerts():
    cfg = RuleConfig(
        budget_usd=0.01,
        enabled_rules=(),            # nothing enabled
    )
    engine = RuleEngine(cfg)
    traces = _trace(agent_id="a1", cost=1.0, n=100)
    assert engine.evaluate(traces) == []


# ---------------------------------------------------------------------------
# Persistence (SQLite alerts table)
# ---------------------------------------------------------------------------

def test_persistence_save_ack_and_list(fresh_alert_db):
    """Alerts round-trip through SQLite, and acknowledge() flips acked=True."""
    alerts._save(Alert(
        id="abc123",
        rule="error_spike",
        severity="warning",
        agent_id="a1",
        agent_name="my_agent",
        message="test",
        trace_ids=["t1", "t2"],
    ))
    rows = alerts.list_alerts(limit=10)
    assert len(rows) == 1
    assert rows[0]["id"] == "abc123"
    assert rows[0]["rule"] == "error_spike"
    assert rows[0]["acked"] is False
    assert rows[0]["trace_ids"] == ["t1", "t2"]

    # Ack and re-list
    assert alerts.acknowledge("abc123") is True
    assert alerts.list_alerts(limit=10)[0]["acked"] is True

    # Acking a non-existent alert is a no-op.
    assert alerts.acknowledge("does-not-exist") is False


def test_list_alerts_filter_by_severity_and_rule(fresh_alert_db):
    for rule, sev in [
        ("budget_breach", "warning"),
        ("error_spike",   "critical"),
        ("error_spike",   "warning"),
    ]:
        alerts._save(Alert(
            id=f"{rule}-{sev}",
            rule=rule,
            severity=sev,
            agent_id="a1",
            agent_name="n",
            message="m",
        ))
    assert len(alerts.list_alerts(severity="critical")) == 1
    assert len(alerts.list_alerts(rule="error_spike")) == 2
    assert len(alerts.list_alerts(severity="critical", rule="error_spike")) == 1


def test_list_alerts_excludes_acked_by_default(fresh_alert_db):
    alerts._save(Alert(id="x", rule="r", severity="info",
                       agent_id="a", agent_name="n", message="m"))
    assert len(alerts.list_alerts()) == 1
    alerts.acknowledge("x")
    assert len(alerts.list_alerts()) == 1               # include_acked=True
    assert len(alerts.list_alerts(include_acked=False)) == 0


# ---------------------------------------------------------------------------
# configure() + state machine
# ---------------------------------------------------------------------------

def test_configure_returns_latest_rule_config():
    alerts._config = None
    alerts._webhook = ""
    cfg = alerts.configure(
        webhook="https://example.com/hook",
        budget_usd=12.0,
        error_rate_threshold=0.25,
    )
    assert cfg.budget_usd == 12.0
    assert cfg.error_rate_threshold == 0.25
    assert alerts._webhook == "https://example.com/hook"

    # Re-configure without budget → keep prior value.
    alerts.configure(latency_p95_sec=99.0)
    assert alerts._config.budget_usd == 12.0
    assert alerts._config.latency_p95_sec == 99.0


# ---------------------------------------------------------------------------
# Webhook delivery
# ---------------------------------------------------------------------------

def test_deliver_slack_format_uses_attachments():
    alert = Alert(
        id="a", rule="budget_breach", severity="critical",
        agent_id="agt-1", agent_name="my_agent",
        message="spent too much",
    )
    captured = {}

    class FakeResp:
        status = 200

    def fake_urlopen(req, timeout):
        captured["url"]   = req.full_url
        captured["body"]  = json.loads(req.data.decode())
        return FakeResp()

    with patch("swarmtrace.alerts.urlopen", fake_urlopen):
        ok = alerts.deliver(alert, "https://hooks.slack.com/services/T/B/X")
    assert ok is True
    assert captured["url"] == "https://hooks.slack.com/services/T/B/X"
    payload = captured["body"]
    # Slack format uses `text` + `attachments[].fields`, NOT a `source` wrapper.
    assert "text" in payload
    assert "attachments" in payload
    assert payload["attachments"][0]["color"] == "#ef4444"     # critical
    assert "swarmtrace" not in {payload.get("source")}


def test_deliver_generic_format_is_typed_envelope():
    alert = Alert(
        id="a", rule="error_spike", severity="warning",
        agent_id="agt-1", agent_name="my_agent", message="x",
    )
    captured = {}

    class FakeResp:
        status = 200

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode())
        return FakeResp()

    with patch("swarmtrace.alerts.urlopen", fake_urlopen):
        ok = alerts.deliver(alert, "https://example.com/hook")
    assert ok is True
    body = captured["body"]
    assert body["source"] == "swarmtrace"
    assert body["version"] == 1
    assert body["alert"]["rule"] == "error_spike"


def test_deliver_retries_on_transient_failure():
    """Network blip → first two attempts fail, third succeeds."""
    alert = Alert(
        id="a", rule="r", severity="info",
        agent_id="a", agent_name="a", message="m",
    )
    call_count = {"n": 0}

    class FakeResp:
        status = 200

    def flaky_urlopen(req, timeout):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise OSError("network down")
        return FakeResp()

    with patch("swarmtrace.alerts.urlopen", flaky_urlopen), \
         patch("swarmtrace.alerts.time.sleep"):  # skip the actual backoff
        ok = alerts.deliver(alert, "https://example.com/hook", retries=3)
    assert ok is True
    assert call_count["n"] == 3
    assert alert.delivered is True


def test_deliver_returns_false_after_all_retries():
    alert = Alert(
        id="a", rule="r", severity="info",
        agent_id="a", agent_name="a", message="m",
    )

    def always_fail(req, timeout):
        raise OSError("nope")

    with patch("swarmtrace.alerts.urlopen", always_fail), \
         patch("swarmtrace.alerts.time.sleep"):
        ok = alerts.deliver(alert, "https://example.com/hook", retries=3)
    assert ok is False
    assert alert.delivered is False


# ---------------------------------------------------------------------------
# AlertRunner — background thread integration
# ---------------------------------------------------------------------------

def test_alert_runner_invokes_on_alert_callback(fresh_alert_db, monkeypatch):
    """The runner must call on_alert and persist alerts on every tick."""
    monkeypatch.setattr(alerts, "get_all_traces",
                        lambda limit=2000: _trace(agent_id="a1", cost=1.0, n=10))

    seen = []
    runner = alerts.AlertRunner(
        alerts.get_engine(),
        webhook="",
        interval_seconds=0,
        on_alert=lambda a: seen.append(a),
    )
    runner._tick()
    assert len(seen) == 1
    assert seen[0].rule == "budget_breach"
    assert alerts.list_alerts(limit=5), "alert should be persisted to SQLite"


def test_alert_runner_starts_and_stops_cleanly(fresh_alert_db, monkeypatch):
    monkeypatch.setattr(alerts, "get_all_traces", lambda limit=2000: [])
    runner = alerts.AlertRunner(alerts.get_engine(), interval_seconds=0)
    runner.start()
    assert runner._thread is not None
    assert runner._thread.is_alive()
    runner.stop()
    # Give the daemon a moment to exit
    runner._thread.join(timeout=1.0)
    assert not runner._thread.is_alive()
