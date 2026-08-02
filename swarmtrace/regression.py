import json
import logging
import os
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.request import Request, urlopen

from swarmtrace.redact import redact

_log = logging.getLogger("swarmtrace.regression")

DEFAULT_THRESHOLD = 0.6

# Mirrors the dashboard ingest cap (frontend-next/lib/validate-ingest.ts
# MAX_TEXT_LEN) so reported text is never truncated server-side into a
# different value than what the client sent.
MAX_TEXT_LEN = 32000
MAX_RESULTS = 200


def _get_llm():
    """Lazy-load LLM at call time — avoids import-time crash if key is missing."""
    try:
        from litai import LLM
    except ImportError as exc:
        raise ImportError(
            "[swarmtrace] Regression detection needs the optional 'litai' package.\n"
            "Install it with:\n"
            "  pip install swarmtrace[regression]\n"
            "Or pass your own llm callable to compare(..., llm=my_llm)."
        ) from exc

    api_key = os.environ.get("LIGHTNING_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "[swarmtrace] LIGHTNING_API_KEY environment variable is not set.\n"
            "Export it before using regression detection:\n"
            "  export LIGHTNING_API_KEY=your_key_here\n"
            "Or pass your own llm callable to compare(..., llm=my_llm) — any\n"
            "function that takes a prompt string and returns a string works\n"
            "(e.g. a thin wrapper around the OpenAI or Anthropic SDK)."
        )
    client = LLM(
        model=os.environ.get("SWARMTRACE_REGRESSION_MODEL", "anthropic/claude-haiku-4-5-20251001"),
        api_key=api_key,
    )
    return client.chat


def score_similarity(output_a: str, output_b: str, llm=None) -> float:
    """Use AI to score how similar two outputs are. Returns 0.0–1.0.

    ``llm`` is any callable that takes a prompt string and returns a string.
    Defaults to litai routed via LIGHTNING_API_KEY.

    Never raises: a failure calling ``llm`` and a non-numeric/unparsable
    response are handled as two separate, independent failure modes, each
    falling back to 0.5 (neutral) — so neither a flaky scorer nor a bad
    response can ever crash ``compare()``.
    """
    if llm is None:
        llm = _get_llm()
    prompt = f"""Compare these two AI outputs and return ONLY a number between 0.0 and 1.0.
1.0 = identical meaning. 0.0 = completely different.

Output A: {output_a[:300]}
Output B: {output_b[:300]}

Reply with just the number, nothing else."""

    # Isolated from the parsing step below: if the user-supplied llm callable
    # raises (network/SDK error, bad args, even a ValueError of its own),
    # `score` is never assigned — so this except can't reference it and
    # can't crash with UnboundLocalError the way the parsing failure below
    # legitimately can reference a real (just non-numeric) value.
    try:
        raw = llm(prompt)
    except Exception as exc:
        _log.warning(
            "similarity LLM call failed (%r) — defaulting to 0.5 (neutral).", exc,
        )
        return 0.5

    try:
        return min(1.0, max(0.0, float(raw.strip())))
    except Exception:
        # Non-numeric (or non-string/None) output — warn and default to
        # neutral 0.5 so neither a regression nor a false pass is silently
        # reported.
        _log.warning(
            "similarity LLM returned non-numeric output %.60r — defaulting to 0.5 (neutral). "
            "Check your LLM callable.", raw,
        )
        return 0.5


def _cap_text(value: Any, limit: int = MAX_TEXT_LEN) -> str:
    """Coerce to str and truncate to the dashboard text cap."""
    if value is None:
        return ""
    s = value if isinstance(value, str) else str(value)
    return s[:limit]


def report_run(
    *,
    run_id: Optional[str] = None,
    name: Optional[str] = None,
    threshold: float = DEFAULT_THRESHOLD,
    version_a_prompt: Optional[str] = None,
    version_b_prompt: Optional[str] = None,
    inputs_count: int,
    regressions_count: int,
    duration_sec: float,
    results: List[Dict[str, Any]],
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
) -> bool:
    """Report a prompt-regression run to the SwarmTrace dashboard.

    POSTs to ``{endpoint}/api/regression`` authenticated with the SwarmTrace
    API key (``SWARMTRACE_API_KEY`` / ``SWARMTRACE_ENDPOINT`` env vars, or
    explicit overrides). The dashboard stores the run per-tenant and the
    Regression page displays it.

    **Never raises.** This is a best-effort telemetry report: any failure
    (missing config, network error, 4xx/5xx) is logged as a warning and
    returns ``False``. ``compare(..., report_to_dashboard=True)`` calls this
    internally, so an unreachable dashboard can never break a comparison run.

    ``results`` is a list of per-input dicts with keys: ``input``,
    ``output_a``, ``output_b``, ``latency_a_sec``, ``latency_b_sec``,
    ``similarity``. Text is truncated to 32 000 chars and PII-redacted
    (emails, API keys, card numbers, JWTs) before transmission — the
    dashboard redacts again at the ingest boundary.
    """
    from swarmtrace.config import resolve_remote_config

    key, base_url = resolve_remote_config(
        api_key_override=api_key,
        endpoint_override=endpoint,
    )
    if not key or not base_url:
        _log.warning(
            "[swarmtrace] SWARMTRACE_API_KEY / SWARMTRACE_ENDPOINT not configured — "
            "skipping dashboard report for regression run%s.",
            f" '{name}'" if name else "",
        )
        return False

    if len(results) > MAX_RESULTS:
        _log.warning(
            "truncating %d result entries to %d for dashboard report.",
            len(results), MAX_RESULTS,
        )
        results = results[:MAX_RESULTS]

    payload = {
        "run_id": run_id or uuid.uuid4().hex,
        "name": (name or "")[:200] or None,
        "threshold": float(threshold),
        "version_a_prompt": redact(_cap_text(version_a_prompt)) or None,
        "version_b_prompt": redact(_cap_text(version_b_prompt)) or None,
        "inputs_count": int(inputs_count),
        "regressions_count": int(regressions_count),
        "duration_sec": float(duration_sec),
        "results": [
            {
                "input": redact(_cap_text(r.get("input"))),
                "output_a": redact(_cap_text(r.get("output_a"))) or None,
                "output_b": redact(_cap_text(r.get("output_b"))) or None,
                "latency_a_sec": float(r.get("latency_a_sec") or 0.0),
                "latency_b_sec": float(r.get("latency_b_sec") or 0.0),
                "similarity": min(1.0, max(0.0, float(r.get("similarity") or 0.5))),
            }
            for r in results
        ],
    }

    body = json.dumps(payload).encode("utf-8")
    req = Request(
        f"{base_url}/api/regression",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-API-Key": key,
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=10) as resp:
            status = resp.status
    except Exception as exc:  # network error, timeout, HTTP error, anything
        _log.warning(
            "dashboard regression report failed (%r) — run results are still "
            "available in this process's logs.",
            exc,
        )
        return False

    if not (200 <= status < 300):
        _log.warning(
            "dashboard regression report rejected with HTTP %s — check that "
            "SWARMTRACE_API_KEY is valid and the endpoint is up to date.",
            status,
        )
        return False

    _log.info("regression run%s reported to dashboard (run_id=%s).",
              f" '{name}'" if name else "", payload["run_id"])
    return True


def compare(func, inputs: list, version_a_prompt: str, version_b_prompt: str,
            threshold: float = DEFAULT_THRESHOLD, llm=None,
            *,
            report_to_dashboard: bool = False,
            run_name: Optional[str] = None,
            api_key: Optional[str] = None,
            endpoint: Optional[str] = None):
    """
    Compare two prompt versions against the same inputs.
    Detects regressions automatically.

    Args:
        func: callable(input_text, prompt) -> str, the agent under test.
        inputs: list of input strings to evaluate both prompts on.
        version_a_prompt: the baseline prompt.
        version_b_prompt: the candidate prompt.
        threshold: similarity below this counts as a regression (default 0.6).
        llm: optional callable(prompt) -> str used for similarity scoring;
             defaults to litai via LIGHTNING_API_KEY.
        report_to_dashboard: if True, upload the run (per-input scores and
             latencies) to the SwarmTrace dashboard Regression page via
             POST /api/regression. Best-effort — a failure is logged and
             never raises. Requires SWARMTRACE_API_KEY and (optionally)
             SWARMTRACE_ENDPOINT to be configured.
        run_name: optional display name for the dashboard report.
        api_key / endpoint: optional overrides for SWARMTRACE_API_KEY /
             SWARMTRACE_ENDPOINT (only used when report_to_dashboard=True).

    Returns:
        int — number of inputs flagged as regressions (unchanged from
        earlier versions; existing callers are unaffected).
    """
    if llm is None:
        llm = _get_llm()  # resolve once up front — fail fast, not mid-run

    _log.info("Comparing v1 vs v2 on %d inputs...", len(inputs))
    _log.info(
        "%-30s %-12s %-12s %-12s %s",
        "INPUT", "V1 LATENCY", "V2 LATENCY", "SIMILARITY", "REGRESSION?",
    )
    _log.info("-" * 85)

    regressions = 0
    results: List[Dict[str, Any]] = []
    start_total = time.time()

    for input_text in inputs:
        start = time.time()
        out_a = func(input_text, version_a_prompt)
        lat_a = round(time.time() - start, 2)

        start = time.time()
        out_b = func(input_text, version_b_prompt)
        lat_b = round(time.time() - start, 2)

        similarity = score_similarity(out_a, out_b, llm=llm)
        regressed = similarity < threshold
        if regressed:
            regressions += 1

        results.append({
            "input": input_text,
            "output_a": out_a,
            "output_b": out_b,
            "latency_a_sec": lat_a,
            "latency_b_sec": lat_b,
            "similarity": similarity,
        })

        flag = "🔴 YES" if regressed else "✅ NO"
        short_input = input_text[:28] + ".." if len(input_text) > 28 else input_text
        _log.info(
            "%-30s %-12s %-12s %-12s %s",
            short_input, f"{lat_a}s", f"{lat_b}s", str(similarity), flag,
        )

    duration_sec = round(time.time() - start_total, 2)

    _log.info("=" * 85)
    _log.info("Result: %d/%d regressions detected", regressions, len(inputs))
    if regressions > 0:
        _log.warning("⚠️  WARNING: Your new prompt may have regressed!")
    else:
        _log.info("✅ No regressions. Safe to ship.")

    if report_to_dashboard:
        report_run(
            name=run_name,
            threshold=threshold,
            version_a_prompt=version_a_prompt,
            version_b_prompt=version_b_prompt,
            inputs_count=len(inputs),
            regressions_count=regressions,
            duration_sec=duration_sec,
            results=results,
            api_key=api_key,
            endpoint=endpoint,
        )

    return regressions
