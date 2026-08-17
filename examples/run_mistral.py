#!/usr/bin/env python3
"""Manual end-to-end verification of swarmtrace.run() with a real Mistral call.

Run with:

    export MISTRAL_API_KEY="..."
    python examples/run_mistral.py

Then inspect the local SQLite DB or the dashboard to confirm a root
``agent`` run and a child ``llm`` span are linked by ``parent_id``.
"""

from __future__ import annotations

import os

import swarmtrace
from mistralai.client import Mistral


def main() -> None:
    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise SystemExit("Set MISTRAL_API_KEY before running this example.")

    client = Mistral(api_key=api_key)

    with swarmtrace.run("research-agent") as run_ctx:
        print(f"run started: span_id={run_ctx.span_id}")

        with swarmtrace.span("mistral-chat", kind="llm"):
            response = client.chat.complete(
                model="mistral-small-latest",
                messages=[
                    {
                        "role": "user",
                        "content": "What is SwarmTrace in one sentence?",
                    }
                ],
            )
            content = response.choices[0].message.content
            print(f"Mistral response: {content.strip()}")

        print(f"run finished: span_id={run_ctx.span_id}")

    print("\nCheck ~/.swarmtrace.db or the dashboard for a root 'agent' row")
    print("and a child 'llm' row whose parent_id matches the agent span_id.")


if __name__ == "__main__":
    main()
