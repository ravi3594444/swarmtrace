#!/usr/bin/env python3
"""Manual end-to-end verification of swarmtrace.run() with a real LLM call.

Run with:

    export OPENAI_API_KEY="..."
    python examples/run_openai.py

Then inspect the local SQLite DB or the dashboard to confirm a root
``agent`` run and a child ``llm`` span are linked by ``parent_id``.
"""

from __future__ import annotations

import os

from openai import OpenAI

import swarmtrace


def main() -> None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("Set OPENAI_API_KEY before running this example.")

    client = OpenAI(api_key=api_key)

    # Auto-instrumentation is required so the raw OpenAI call is recorded as a
    # child span. init() is idempotent, so calling it here is safe even if the
    # user already configured it elsewhere.
    swarmtrace.init(auto_instrument=True)

    with swarmtrace.run("research-agent") as run_ctx:
        print(f"run started: span_id={run_ctx.span_id}")

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "user", "content": "What is SwarmTrace in one sentence?"}
            ],
        )

        print(f"LLM response: {response.choices[0].message.content.strip()}")
        print(f"run finished: span_id={run_ctx.span_id}")

    print("\nCheck ~/.swarmtrace.db or the dashboard for a root 'agent' row")
    print("and a child 'llm' row whose parent_id matches the agent span_id.")


if __name__ == "__main__":
    main()
