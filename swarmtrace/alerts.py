"""
Alert engine for swarmtrace.

Watches the local trace DB (or remote ingest endpoint) and fires alerts when
rule conditions trip. Alerts are:

1. Persisted to a local SQLite table (``swarmtrace_alerts``) so the dashboard
   can list them and you can query history from the CLI.
2. Delivered to a webhook (``SWARMTRACE_ALERT_WEBHOOK``) — Slack-compatible
   JSON, generic JSON, or email-stub. Retries 3× with exponential backoff.
3. Optional: forwarded to the SwarmTrace dashboard via the same X-API-Key +
   /api/alerts/webhook route the dashboard exposes, so alerts show up in
   the UI even when the SDK is running on a machine without a public URL.

The default rules (each one configurable / disable-able):

* ``budget_breach``      — cumulative ``cost_usd`` for an agent exceeds
                           ``budget_usd`` (default $5) over the last
                           ``window_minutes`` (default 60).
* ``error_spike``        — error rate over the last ``min_traces`` (default 25)
                           traces for an agent exceeds ``error_rate_threshold``
                           (default 0.5 = 50%).
* ``latency_regression`` — p95 latency over the last ``min_traces`` traces
                           exceeds ``latency_p95_sec`` (default 30s).

A per-(rule, agent) cooldown (default 5 min) prevents alert spam.

Usage::

    from swarmtrace import init, observe
    from swarmtrace.alerts import configure

    configure(
        webhook="https://hooks.slack.com/services/...",
        budget_usd=10.0,
        error_rate_threshold=0.4,
    )

    init(api_key="sk-...", endpoint="https://swarmtrace.dev", alerts=True)

    @observe
    def my_agent(q): ...
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from swarmtrace.storage import TraceRow, get_all_traces

_log = logging.getLogger("swarmtrace.alerts")

# ---------------------------------------------------------------------------
# Schema — keep the alerts table in a SEPARATE SQLite file so the trace DB
# stays a pure append-only log and the alert DB can be rotated independently.
# ---------------------------------------------------------------------------

ALERT_DB_PATH = os.environ.get(
    "SWARMTRACE_ALERT_DB_PATH",
    os.path.expanduser("~/.swarmtrace_alerts.db"),
)

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(ALERT_DB_PATH, check_same_thread=False)
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id          TEXT    PRIMARY KEY,
                rule        TEXT    NOT NULL,
                severity    TEXT    NOT NULL,
                agent_id    TEXT,
                agent_name  TEXT,
                message     TEXT    NOT NULL,
                detail      TEXT,
                trace_ids   TEXT,    -- JSON array
                fired_at    TEXT    NOT NULL,
                acked       INTEGER NOT NULL DEFAULT 0,
                acked_at    TEXT,
                delivered   INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts(fired_at DESC)"
        )
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_alerts_agent ON alerts(agent_id, rule)"
        )
        _conn.commit()
    return _conn


def _save(alert: Alert) -> None:
    try:
        with _lock:
            conn = _get_conn()
            conn.execute(
                """
                INSERT OR REPLACE INTO alerts
                (id, rule, severity, agent_id, agent_name, message, detail,
                 trace_ids, fired_at, acked, acked_at, delivered)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    alert.id, alert.rule, alert.severity,
                    alert.agent_id, alert.agent_name, alert.message,
                    alert.detail, json.dumps(alert.trace_ids),
                    alert.fired_at, int(alert.acked),
                    alert.acked_at, int(alert.delivered),
                ),
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001 -- storage boundary: must never crash the caller on a persistence hiccup
        _log.warning("save warning: %s", exc)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

VALID_SEVERITIES = ("info", "warning", "critical")


@dataclass
class Alert:
    id:         str
    rule:       str
    severity:   str       # 'info' | 'warning' | 'critical'
    agent_id:   str | None
    agent_name: str | None
    message:    str
    detail:     str | None = None
    trace_ids:  list[str]  = field(default_factory=list)
    fired_at:   str        = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    acked:      bool       = False
    acked_at:   str | None = None
    delivered:  bool       = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["acked"] = bool(d["acked"])
        d["delivered"] = bool(d["delivered"])
        return d


# ---------------------------------------------------------------------------
# Rule engine
# ---------------------------------------------------------------------------

@dataclass
class RuleConfig:
    """Thresholds for the built-in rules."""
    # budget_breach
    budget_usd:            float = 5.0
    window_minutes:        int   = 60

    # error_spike
    error_rate_threshold:  float = 0.5
    min_traces:            int   = 25

    # latency_regression
    latency_p95_sec:       float = 30.0

    # global
    cooldown_seconds:      int   = 300      # 5 min per (rule, agent)
    enabled_rules:         tuple = ("budget_breach", "error_spike", "latency_regression")


class RuleEngine:
    """Evaluates the built-in rules against the most recent traces."""

    def __init__(self, config: RuleConfig | None = None):
        self.config = config or RuleConfig()
        # (rule, agent_id) -> last-fired timestamp
        self._cooldowns: dict[tuple, float] = {}

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_ts(ts: str) -> datetime | None:
        if not ts:
            return None
        try:
            # ISO-8601 with trailing 'Z' is what datetime.fromisoformat chokes on
            # in 3.10 and earlier — normalise.
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            dt = datetime.fromisoformat(ts)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except (ValueError, TypeError):
            return None

    def _in_cooldown(self, rule: str, agent_id: str) -> bool:
        key = (rule, agent_id)
        last = self._cooldowns.get(key)
        if last is None:
            return False
        return (time.time() - last) < self.config.cooldown_seconds

    def _mark_fired(self, rule: str, agent_id: str) -> None:
        self._cooldowns[(rule, agent_id)] = time.time()

    # ── public entrypoint ────────────────────────────────────────────────────

    def evaluate(self, traces: list[TraceRow]) -> list[Alert]:
        """Run every enabled rule over ``traces`` and return the fired alerts."""
        # Each trace row is a dict from the storage layer (see
        # storage.py:TraceRow) -- keyed by column name, so this survives any
        # future schema migration without changes here.
        if not traces:
            return []

        # Bucket by agent_id for rules that need per-agent aggregation.
        by_agent: dict[str, list[TraceRow]] = {}
        for row in traces:
            agent_id = row["agent_id"] or row["id"] or "unknown"
            by_agent.setdefault(agent_id, []).append(row)

        fired: list[Alert] = []
        if "budget_breach"      in self.config.enabled_rules:
            fired.extend(self._rule_budget_breach(traces, by_agent))
        if "error_spike"        in self.config.enabled_rules:
            fired.extend(self._rule_error_spike(by_agent))
        if "latency_regression" in self.config.enabled_rules:
            fired.extend(self._rule_latency_regression(by_agent))
        return fired

    # ── rules ────────────────────────────────────────────────────────────────

    def _rule_budget_breach(
        self, traces: list[TraceRow], by_agent: dict[str, list[TraceRow]]
    ) -> list[Alert]:
        cfg = self.config
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=cfg.window_minutes)
        fired: list[Alert] = []
        for agent_id, rows in by_agent.items():
            if self._in_cooldown("budget_breach", agent_id):
                continue
            total = 0.0
            trace_ids: list[str] = []
            latest_ts: datetime | None = None
            agent_name = None
            for row in rows:
                ts = self._parse_ts(row["timestamp"])
                if ts is None or ts < cutoff:
                    continue
                total += float(row["cost_usd"] or 0.0)
                trace_ids.append(row["id"])
                if latest_ts is None or ts > latest_ts:
                    latest_ts = ts
                agent_name = agent_name or row["agent_name"]
            if total >= cfg.budget_usd:
                fired.append(Alert(
                    id=uuid.uuid4().hex,
                    rule="budget_breach",
                    severity="critical" if total >= cfg.budget_usd * 2 else "warning",
                    agent_id=agent_id,
                    agent_name=agent_name or agent_id,
                    message=(
                        f"{agent_name or agent_id} spent ${total:.2f} in the last "
                        f"{cfg.window_minutes} min (threshold ${cfg.budget_usd:.2f})"
                    ),
                    detail=json.dumps({
                        "cost_usd":      round(total, 6),
                        "window_min":    cfg.window_minutes,
                        "threshold_usd": cfg.budget_usd,
                        "trace_count":   len(trace_ids),
                    }),
                    trace_ids=trace_ids[:50],
                ))
                self._mark_fired("budget_breach", agent_id)
        return fired

    def _rule_error_spike(self, by_agent: dict[str, list[TraceRow]]) -> list[Alert]:
        cfg = self.config
        fired: list[Alert] = []
        for agent_id, rows in by_agent.items():
            if self._in_cooldown("error_spike", agent_id):
                continue
            # Traces are ordered DESC by timestamp from storage — take the most recent N.
            recent = rows[: cfg.min_traces]
            if len(recent) < cfg.min_traces:
                continue
            errors = sum(1 for r in recent if r["error"])
            rate = errors / len(recent)
            if rate >= cfg.error_rate_threshold:
                agent_name = next((r["agent_name"] for r in recent if r["agent_name"]), agent_id)
                fired.append(Alert(
                    id=uuid.uuid4().hex,
                    rule="error_spike",
                    severity="critical" if rate >= 0.9 else "warning",
                    agent_id=agent_id,
                    agent_name=agent_name,
                    message=(
                        f"{agent_name} error rate {rate*100:.0f}% over the last "
                        f"{len(recent)} calls (threshold {cfg.error_rate_threshold*100:.0f}%)"
                    ),
                    detail=json.dumps({
                        "errors":     errors,
                        "total":      len(recent),
                        "rate":       round(rate, 4),
                        "threshold":  cfg.error_rate_threshold,
                    }),
                    trace_ids=[r["id"] for r in recent if r["error"]][:50],
                ))
                self._mark_fired("error_spike", agent_id)
        return fired

    def _rule_latency_regression(self, by_agent: dict[str, list[TraceRow]]) -> list[Alert]:
        cfg = self.config
        fired: list[Alert] = []
        for agent_id, rows in by_agent.items():
            if self._in_cooldown("latency_regression", agent_id):
                continue
            recent = rows[: cfg.min_traces]
            if len(recent) < cfg.min_traces:
                continue
            latencies = sorted(
                float(r["latency_sec"] or 0.0) for r in recent
            )
            # Round UP to the next sample so the slowest 5% (i.e. the trailing
            # outlier we actually care about) is what p95 reports. Using
            # ``int(N * 0.95) - 1`` collapses to the 95th-into-the-array instead.
            n = len(latencies)
            p95_idx = max(0, min(n - 1, int(n * 0.95 + 0.999999)))
            p95 = latencies[p95_idx]
            if p95 >= cfg.latency_p95_sec:
                agent_name = next((r["agent_name"] for r in recent if r["agent_name"]), agent_id)
                fired.append(Alert(
                    id=uuid.uuid4().hex,
                    rule="latency_regression",
                    severity="warning",
                    agent_id=agent_id,
                    agent_name=agent_name,
                    message=(
                        f"{agent_name} p95 latency {p95:.1f}s over the last "
                        f"{len(recent)} calls (threshold {cfg.latency_p95_sec:.1f}s)"
                    ),
                    detail=json.dumps({
                        "p95":      round(p95, 3),
                        "min":      round(latencies[0], 3),
                        "max":      round(latencies[-1], 3),
                        "samples":  len(latencies),
                        "threshold": cfg.latency_p95_sec,
                    }),
                    trace_ids=[r["id"] for r in recent[:50]],
                ))
                self._mark_fired("latency_regression", agent_id)
        return fired


# ---------------------------------------------------------------------------
# Webhook delivery
# ---------------------------------------------------------------------------

def _slack_payload(alert: Alert) -> dict[str, Any]:
    """Slack-compatible incoming-webhook payload."""
    colour = {
        "info":     "#3b82f6",
        "warning":  "#f59e0b",
        "critical": "#ef4444",
    }.get(alert.severity, "#6b7280")
    return {
        "text":   f":rotating_light: *SwarmTrace alert:* {alert.message}",
        "attachments": [{
            "color":  colour,
            "fields": [
                {"title": "Rule",     "value": alert.rule,       "short": True},
                {"title": "Severity", "value": alert.severity,   "short": True},
                {"title": "Agent",    "value": alert.agent_name, "short": True},
                {"title": "Fired",    "value": alert.fired_at,   "short": True},
            ],
        }],
    }


def _generic_payload(alert: Alert) -> dict[str, Any]:
    return {
        "source":     "swarmtrace",
        "version":    1,
        "alert":      alert.to_dict(),
    }


def deliver(alert: Alert, webhook: str, *, retries: int = 3) -> bool:
    """
    POST an alert to ``webhook``. Auto-detects Slack vs generic JSON by URL.

    Returns True on 2xx, False otherwise. Retries 3× with backoff (1s, 2s).
    """
    if not webhook:
        return False
    if "hooks.slack.com" in webhook:
        payload = _slack_payload(alert)
    else:
        payload = _generic_payload(alert)

    body = json.dumps(payload).encode()
    for attempt in range(retries):
        try:
            req = Request(
                webhook,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            # NOTE: don't use ``with urlopen(...) as resp`` — some test fakes
            # don't implement the context-manager protocol.  Manual
            # try/finally keeps the production code path-clean and the test
            # seam simple.
            resp = urlopen(req, timeout=5)
            try:
                if 200 <= resp.status < 300:
                    alert.delivered = True
                    return True
            finally:
                close = getattr(resp, "close", None)
                if callable(close):
                    close()
        except (URLError, OSError) as exc:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                _log.error("webhook delivery failed: %s", exc)
    return False


# ---------------------------------------------------------------------------
# Forwarder to the SwarmTrace dashboard
# ---------------------------------------------------------------------------

def _forward_to_dashboard(alert: Alert, api_key: str, endpoint: str) -> bool:
    """Best-effort POST to /api/alerts/webhook on the dashboard."""
    if not (api_key and endpoint):
        return False
    url = f"{endpoint.rstrip('/')}/api/alerts/webhook"
    try:
        req = Request(
            url,
            data=json.dumps({"alert": alert.to_dict()}).encode(),
            headers={
                "Content-Type": "application/json",
                "X-API-Key":    api_key,
            },
            method="POST",
        )
        with urlopen(req, timeout=5) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:  # noqa: BLE001 -- best-effort network call, must not raise
        _log.debug("forward-to-dashboard webhook failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Background evaluator
# ---------------------------------------------------------------------------

class AlertRunner:
    """Daemon thread that runs :class:`RuleEngine` on an interval."""

    def __init__(
        self,
        engine: RuleEngine,
        *,
        webhook: str = "",
        interval_seconds: int = 60,
        api_key: str = "",
        endpoint: str = "",
        on_alert: Callable[[Alert], None] | None = None,
    ):
        self.engine   = engine
        self.webhook  = webhook
        self.interval = interval_seconds
        self.api_key  = api_key
        self.endpoint = endpoint
        self.on_alert = on_alert
        self._stop    = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="swarmtrace-alerts",
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as exc:  # noqa: BLE001 -- daemon loop must never die on one bad tick
                _log.error("tick failed: %s", exc)
            # Wait, but stay responsive to stop().
            self._stop.wait(self.interval)

    def _tick(self) -> None:
        traces = get_all_traces(limit=2000)
        if not traces:
            return
        for alert in self.engine.evaluate(traces):
            _save(alert)
            if self.webhook:
                deliver(alert, self.webhook)
            if self.api_key and self.endpoint:
                _forward_to_dashboard(alert, self.api_key, self.endpoint)
            if self.on_alert:
                try:
                    self.on_alert(alert)
                except Exception:  # noqa: BLE001 -- on_alert is arbitrary user code, must not propagate
                    _log.exception("on_alert callback raised")


# ---------------------------------------------------------------------------
# Global config + lifecycle
# ---------------------------------------------------------------------------

_engine:    RuleEngine | None   = None
_runner:    AlertRunner | None   = None
_config:    RuleConfig | None   = None
_webhook:   str                    = ""
_user_hook: Callable[[Alert], None] | None = None


def configure(
    *,
    webhook: str | None       = None,
    budget_usd: float | None  = None,
    error_rate_threshold: float | None = None,
    latency_p95_sec: float | None = None,
    window_minutes: int | None = None,
    cooldown_seconds: int | None = None,
    enabled_rules: tuple | None = None,
    on_alert: Callable[[Alert], None] | None = None,
) -> RuleConfig:
    """
    Configure (or update) the global alert engine. Safe to call multiple
    times — only the fields you pass are changed.
    """
    global _config, _webhook, _user_hook
    if _config is None:
        _config = RuleConfig()
    if webhook is not None:
        _webhook = webhook
    if budget_usd is not None:
        _config.budget_usd = budget_usd
    if error_rate_threshold is not None:
        _config.error_rate_threshold = error_rate_threshold
    if latency_p95_sec is not None:
        _config.latency_p95_sec = latency_p95_sec
    if window_minutes is not None:
        _config.window_minutes = window_minutes
    if cooldown_seconds is not None:
        _config.cooldown_seconds = cooldown_seconds
    if enabled_rules is not None:
        _config.enabled_rules = tuple(enabled_rules)
    if on_alert is not None:
        _user_hook = on_alert
    return _config


def get_engine() -> RuleEngine:
    global _engine
    if _engine is None:
        _engine = RuleEngine(_config or RuleConfig())
    else:
        # Keep engine in sync with the most recent config.
        _engine.config = _config or RuleConfig()
    return _engine


def start(*, interval_seconds: int = 60) -> None:
    """Start the background alert runner (idempotent)."""
    global _runner
    if _runner and _runner._thread and _runner._thread.is_alive():
        return
    # Pull API key / endpoint lazily so values set after import are honoured.
    try:
        from swarmtrace.config import remote_config
        key, endpoint = remote_config()
    except Exception as exc:  # noqa: BLE001 -- startup config resolution must not block the alert runner
        _log.debug("remote_config lookup failed, remote alerts disabled: %s", exc)
        key, endpoint = "", ""
    _runner = AlertRunner(
        get_engine(),
        webhook=_webhook or os.environ.get("SWARMTRACE_ALERT_WEBHOOK", ""),
        interval_seconds=interval_seconds,
        api_key=key,
        endpoint=endpoint,
        on_alert=_user_hook,
    )
    _runner.start()


def stop() -> None:
    global _runner
    if _runner:
        _runner.stop()
        _runner = None


def evaluate_now() -> list[Alert]:
    """Run the rule engine once over the current trace buffer (for tests / CLI)."""
    return get_engine().evaluate(get_all_traces(limit=2000))


def list_alerts(
    limit: int = 50,
    *,
    severity: str | None = None,
    rule: str | None = None,
    include_acked: bool = True,
) -> list[dict[str, Any]]:
    """Return recent alerts (most recent first)."""
    try:
        with _lock:
            conn = _get_conn()
            query = "SELECT * FROM alerts"
            clauses: list[str] = []
            params: list[Any]  = []
            if not include_acked:
                clauses.append("acked = 0")
            if severity:
                clauses.append("severity = ?")
                params.append(severity)
            if rule:
                clauses.append("rule = ?")
                params.append(rule)
            if clauses:
                query += " WHERE " + " AND ".join(clauses)
            query += " ORDER BY fired_at DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(query, params).fetchall()
        return [_row_to_alert(r).to_dict() for r in rows]
    except Exception as exc:  # noqa: BLE001 -- storage boundary: must never crash the caller on a query hiccup
        _log.warning("list warning: %s", exc)
        return []


def acknowledge(alert_id: str) -> bool:
    """Mark an alert as acknowledged. Returns True if a row was updated."""
    try:
        with _lock:
            conn = _get_conn()
            cur = conn.execute(
                "UPDATE alerts SET acked = 1, acked_at = ? WHERE id = ?",
                (datetime.now(timezone.utc).isoformat(), alert_id),
            )
            conn.commit()
            return cur.rowcount > 0
    except Exception as exc:  # noqa: BLE001 -- storage boundary: must never crash the caller on a query hiccup
        _log.warning("ack warning: %s", exc)
        return False


def _row_to_alert(row: tuple) -> Alert:
    return Alert(
        id=row[0], rule=row[1], severity=row[2],
        agent_id=row[3], agent_name=row[4],
        message=row[5], detail=row[6],
        trace_ids=json.loads(row[7] or "[]"),
        fired_at=row[8],
        acked=bool(row[9]), acked_at=row[10],
        delivered=bool(row[11]),
    )


def _reset_state_for_tests() -> None:
    """
    Reset every module-level piece of state so tests are order-independent.
    Not part of the public API; only ``tests/test_alerts.py`` should call this.
    """
    global _engine, _runner, _config, _webhook, _user_hook, _conn
    # Stop any background runner first so it doesn't keep firing while the
    # test process is alive.
    if _runner and _runner._thread and _runner._thread.is_alive():
        _runner.stop()
        _runner._thread.join(timeout=1.0)
    _engine   = None
    _runner   = None
    _config   = None
    _webhook  = ""
    _user_hook = None
    _conn     = None


__all__ = [
    "Alert",
    "AlertRunner",
    "RuleConfig",
    "RuleEngine",
    "acknowledge",
    "configure",
    "deliver",
    "evaluate_now",
    "get_engine",
    "list_alerts",
    "start",
    "stop",
]
