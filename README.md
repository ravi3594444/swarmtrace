# SwarmTrace

Tracing for AI agents. Decorate a function, inspect the entire call tree (latency, tokens, cost, errors) in your terminal or on a dashboard.

[PyPI](https://pypi.org/project/swarmtrace/) · [Dashboard](https://swarmtrace.vercel.app/) · [Docs](#)

## The problem

An agent that calls a model, then a tool, then another agent, is a black box when it goes wrong. You get a final answer, but no sense of which step was slow, which used the most tokens, which one silently returned garbage that the rest were building on. Print statements don't survive nesting, and most tracing tools expect you to use their framework from the get-go.

## What it does

```bash

pip install swarmtrace

```

```python

import swarmtrace

swarmtrace.init()

@swarmtrace.observe

def my_agent(prompt):

...

```

```bash

swarmtrace  # the call tree for your last runs

```

`init()` patches whichever LLM clients you have installed already, so model calls that happen inside your agent are recorded separately and attributed to it. No configuration needed, no framework to adopt — everything ends up in a local SQLite file, so it works offline, but add an API key and traces also appear on the dashboard. Multi-agent runs are shown as separate nodes with the inter-agent handoffs drawn between them.

## Status

Working

- `@observe` and automatic LLM patching — OpenAI, Anthropic, Gemini, LiteLLM

- Local SQLite storage, offline, capped at 10k rows with age-based purging,

- CLI: view, replay, export to JSON/CSV, resync

- Async, including `asyncio.gather`

- Dashboard with live agent cards and node map

- Cost tracking via LiteLLM's pricing registry

Rough

- `ThreadPoolExecutor` breaks attribution. Context rides on `contextvars`, which thread pools don't propagate, so spans from `ex.map()` / `ex.submit()` become their own top-level traces instead of rolling into the agent. Async is fine, this isn't.

- Under fast concurrent writes SQLite lock contention prints `database table is locked` and that span is dropped, not retried

- Traces queued for the dashboard may not survive a process that exits immediately — delivery is on a background thread. `swarmtrace-resync` recovers anything that reached SQLite

- `@observe` costs ~0.14 ms per call (2,000 calls, local only, no delivery).

- PII redaction before upload is regex-based and best-effort.

- Local and fine-tuned models show zero cost until you call `set_model_pricing`.

Experimental — usable but not hardened: token budgets, prompt regression diffing, tool selection, FOV capture (HTTP, filesystem, screenshots), MCP ingest for agents that can't run the Python package. See docs.

Python 3.10+. No JS/TS SDK.

## Why I built it

Because when I built agents using frameworks like CrewAI and LangGraph, I had no idea what's happening under the hood, but that's why I've built this project. I know that there are things, which I can improve, but I am working on an old laptop, so I cannot always keep up with the newest things.

## License

MIT. Built by [Ravi Kumar](https://raviportfollio.vercel.app/).
