#!/usr/bin/env python3
"""Run Nous Research Hermes Agent with Mistral under a SwarmTrace root run.

This script demonstrates the generic run/span integration point: a third-party
agent (Hermes AIAgent) is wrapped with swarmtrace.run() so its LLM calls appear
as child spans in the SwarmTrace history.

Run with:

    export MISTRAL_API_KEY="..."
    python examples/run_hermes_mistral.py

Expected output: one root "agent" span and one child "llm" span in
~/.swarmtrace.db.
"""

from __future__ import annotations

import os

import swarmtrace


def main() -> None:
    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        raise SystemExit("Set MISTRAL_API_KEY before running this script.")

    # Hermes AIAgent uses an OpenAI-compatible client internally, so we point
    # it at Mistral's API with the user's key.
    from run_agent import AIAgent

    agent = AIAgent(
        base_url="https://api.mistral.ai/v1",
        api_key=api_key,
        model="mistral-small-latest",
    )

    with swarmtrace.run("hermes-mistral-agent") as run_ctx:
        print(f"root run started: span_id={run_ctx.span_id}")

        question = "What is SwarmTrace in one sentence?"
        print(f"question: {question}")

        with swarmtrace.span("hermes-llm-call", kind="llm"):
            response = agent.run_conversation(question)

        if isinstance(response, dict):
            answer = response.get("final_response", "")
            print(f"Hermes response: {answer.strip() if answer else '(no final_response)'}")
        else:
            print(f"Hermes response: {response.strip() if response else '(no response)'}")
        print(f"root run finished: span_id={run_ctx.span_id}")

    print("\nCheck ~/.swarmtrace.db for a root 'agent' row and a child 'llm' row")
    print("whose parent_id matches the agent span_id.")


if __name__ == "__main__":
    main()
