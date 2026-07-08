import logging
import os
import time

_log = logging.getLogger("swarmtrace.regression")

DEFAULT_THRESHOLD = 0.6


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


def compare(func, inputs: list, version_a_prompt: str, version_b_prompt: str,
            threshold: float = DEFAULT_THRESHOLD, llm=None):
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

        flag = "🔴 YES" if regressed else "✅ NO"
        short_input = input_text[:28] + ".." if len(input_text) > 28 else input_text
        _log.info(
            "%-30s %-12s %-12s %-12s %s",
            short_input, f"{lat_a}s", f"{lat_b}s", str(similarity), flag,
        )

    _log.info("=" * 85)
    _log.info("Result: %d/%d regressions detected", regressions, len(inputs))
    if regressions > 0:
        _log.warning("⚠️  WARNING: Your new prompt may have regressed!")
    else:
        _log.info("✅ No regressions. Safe to ship.")
    return regressions
