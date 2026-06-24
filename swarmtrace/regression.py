import os
import time

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
    """
    if llm is None:
        llm = _get_llm()
    prompt = f"""Compare these two AI outputs and return ONLY a number between 0.0 and 1.0.
1.0 = identical meaning. 0.0 = completely different.

Output A: {output_a[:300]}
Output B: {output_b[:300]}

Reply with just the number, nothing else."""
    try:
        score = llm(prompt).strip()
        return min(1.0, max(0.0, float(score)))
    except ValueError:
        # LLM returned non-numeric output — warn and default to neutral 0.5
        # so neither a regression nor a false pass is silently reported.
        import sys
        print(
            f"[swarmtrace] warning: similarity LLM returned non-numeric output "
            f"{score!r:.60} — defaulting to 0.5 (neutral). Check your LLM callable.",
            file=sys.stderr,
        )
        return 0.5
    except Exception:
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

    print(f"\n[swarmtrace Regression] Comparing v1 vs v2 on {len(inputs)} inputs...\n")
    print(f"{'INPUT':<30} {'V1 LATENCY':<12} {'V2 LATENCY':<12} {'SIMILARITY':<12} {'REGRESSION?'}")
    print("-" * 85)

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

        flag = "\U0001f534 YES" if regressed else "\u2705 NO"
        short_input = input_text[:28] + ".." if len(input_text) > 28 else input_text
        print(f"{short_input:<30} {str(lat_a)+'s':<12} {str(lat_b)+'s':<12} {str(similarity):<12} {flag}")

    print(f"\n{'='*85}")
    print(f"Result: {regressions}/{len(inputs)} regressions detected")
    if regressions > 0:
        print("\u26a0\ufe0f  WARNING: Your new prompt may have regressed!")
    else:
        print("\u2705 No regressions. Safe to ship.")
    print()
    return regressions
