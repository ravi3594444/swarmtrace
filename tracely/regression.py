import sys
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")

import os
from litai import LLM
from tracely.storage import get_traces, save_trace
import uuid
from datetime import datetime

llm = LLM(model="anthropic/claude-haiku-4-5-20251001", api_key=os.environ.get("LIGHTNING_API_KEY"))

def score_similarity(output_a: str, output_b: str) -> float:
    """Use AI to score how similar two outputs are. Returns 0.0 to 1.0"""
    prompt = f"""Compare these two AI outputs and return ONLY a number between 0.0 and 1.0.
1.0 = identical meaning. 0.0 = completely different.

Output A: {output_a[:300]}
Output B: {output_b[:300]}

Reply with just the number, nothing else."""

    score = llm.chat(prompt).strip()
    try:
        return float(score)
    except:
        return 0.5

def compare(func, inputs: list, version_a_prompt: str, version_b_prompt: str):
    """
    Compare two prompt versions against the same inputs.
    Detects regressions automatically.
    """
    print(f"\n[Tracely Regression] Comparing v1 vs v2 on {len(inputs)} inputs...\n")
    print(f"{'INPUT':<30} {'V1 LATENCY':<12} {'V2 LATENCY':<12} {'SIMILARITY':<12} {'REGRESSION?'}")
    print("-" * 85)

    regressions = 0

    for input_text in inputs:
        # Run v1
        import time
        start = time.time()
        out_a = func(input_text, version_a_prompt)
        lat_a = round(time.time() - start, 2)

        # Run v2
        start = time.time()
        out_b = func(input_text, version_b_prompt)
        lat_b = round(time.time() - start, 2)

        # Score similarity
        similarity = score_similarity(out_a, out_b)
        regressed = similarity < 0.6

        if regressed:
            regressions += 1

        flag = "🔴 YES" if regressed else "✅ NO"
        short_input = input_text[:28] + ".." if len(input_text) > 28 else input_text
        print(f"{short_input:<30} {str(lat_a)+'s':<12} {str(lat_b)+'s':<12} {str(similarity):<12} {flag}")

    print(f"\n{'='*85}")
    print(f"Result: {regressions}/{len(inputs)} regressions detected")
    if regressions > 0:
        print("⚠️  WARNING: Your new prompt may have regressed!")
    else:
        print("✅ No regressions. Safe to ship.")
    print()
