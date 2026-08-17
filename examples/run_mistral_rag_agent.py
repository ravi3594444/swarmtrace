#!/usr/bin/env python3
"""Real-LLM RAG-style agent test using swarmtrace.run() and Mistral.

Run with:

    export MISTRAL_API_KEY="..."
    python examples/run_mistral_rag_agent.py

The agent:
1. Starts a root agent run.
2. Generates a search query from the user question (llm span).
3. Simulates a retrieval step (retrieval span) — in production this could be
   Tavily, Firecrawl, or a vector DB.
4. Calls Mistral again with the retrieved context to produce the final answer
   (llm span).

Expected SQLite output: one root agent row and three child rows with
parent_id set to the agent span_id.
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
    model = "mistral-small-latest"

    question = "What is SwarmTrace and what problem does it solve?"

    with swarmtrace.run("mistral-rag-agent") as run_ctx:
        print(f"agent run started: span_id={run_ctx.span_id}")

        # Step 1: generate a focused search query
        with swarmtrace.span("generate-query", kind="llm"):
            query_response = client.chat.complete(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a search-query generator. Rewrite the user's question as a concise web-search query. Output only the query.",
                    },
                    {"role": "user", "content": question},
                ],
            )
            search_query = query_response.choices[0].message.content.strip()
            print(f"search query: {search_query}")

        # Step 2: simulate retrieval (replace with real tool in production)
        with swarmtrace.span("retrieve-docs", kind="retrieval"):
            # Simulated retrieval result. In a real agent this would call
            # Tavily, Firecrawl, a vector DB, etc.
            retrieved_context = (
                "SwarmTrace is an observability platform for AI agents. It records the "
                "complete history of an agent run including LLM calls, tool calls, "
                "sub-agents, retrieval/browser events, outputs, and errors. It is "
                "designed to work through standard connection methods like MCP, "
                "OpenTelemetry, or a generic run/span API."
            )
            print(f"retrieved {len(retrieved_context)} chars of context")

        # Step 3: answer with the retrieved context
        with swarmtrace.span("generate-answer", kind="llm"):
            answer_response = client.chat.complete(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "Answer the user's question using only the provided context. Keep it to 2 sentences.",
                    },
                    {
                        "role": "user",
                        "content": f"Context: {retrieved_context}\n\nQuestion: {question}",
                    },
                ],
            )
            answer = answer_response.choices[0].message.content.strip()
            print(f"final answer: {answer}")

        print(f"agent run finished: span_id={run_ctx.span_id}")

    print("\nCheck ~/.swarmtrace.db for a root 'agent' row and child 'llm'/'retrieval rows")
    print("whose parent_id matches the agent span_id.")


if __name__ == "__main__":
    main()
