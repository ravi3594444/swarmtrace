#!/usr/bin/env python3
"""Manual end-to-end verification of swarmtrace.run() with a real Gemini call.

Run with:

    export GEMINI_API_KEY="..."
    python examples/run_gemini.py

Then inspect the local SQLite DB or the dashboard to confirm a root
``agent`` run and a child ``llm`` span are linked by ``parent_id``.
"""

from __future__ import annotations

import os

import google.generativeai as genai

import swarmtrace


def main() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Set GEMINI_API_KEY before running this example.")

    genai.configure(api_key=api_key)

    # Auto-instrumentation patches google.generativeai.GenerativeModel.
    swarmtrace.init(auto_instrument=True)

    with swarmtrace.run("research-agent") as run_ctx:
        print(f"run started: span_id={run_ctx.span_id}")

        model = genai.GenerativeModel("gemini-3.5-flash")
        response = model.generate_content("What is SwarmTrace in one sentence?")

        print(f"Gemini response: {response.text.strip()}")
        print(f"run finished: span_id={run_ctx.span_id}")

    print("\nCheck ~/.swarmtrace.db or the dashboard for a root 'agent' row")
    print("and a child 'llm' row whose parent_id matches the agent span_id.")


if __name__ == "__main__":
    main()
