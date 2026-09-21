# SwarmTrace

Tracing for AI agents. Decorate a function, inspect the entire call tree (latency, tokens, cost, errors) in your terminal or on a dashboard.

[PyPI](https://pypi.org/project/swarmtrace/) · [Dashboard](https://swarmtrace.vercel.app/)

This is my very own AI agent tracing tool! I just really got tired of not knowing what my agents were doing under the hood lol.

## What does it have?

- **Decorator & Auto-Patching**: A simple `@observe` decorator that hooks into OpenAI, Anthropic, Gemini, and LiteLLM automatically to capture all sub-calls.
- **CLI Inspection**: A terminal interface to view call trees, replay runs, and export data directly from your local environment.
- **Offline-First Storage**: Uses a local SQLite database that caps at 10,000 rows so it doesn't clutter your drive or consume extra resources.
- **Live Dashboard**: An optional web dashboard where you can view live agent cards and interactive inter-agent handoffs.
- **Cost & Latency Tracking**: Uses LiteLLM's pricing registry to break down cost and time spent per span.

## Why I built it

When I built agents using frameworks like CrewAI and LangGraph, I had no idea what was happening under the hood when things failed. Print statements broke down on nested async calls, and other tracing tools felt too heavy for my old laptop or required rewriting code around their frameworks. I wanted something fast, lightweight, and simple that just works.

## Current Status

- **What's Working**: `@observe` decorator, local SQLite logging, CLI suite, `asyncio` support, dashboard visualization, and cost tracking.
- **Rough Edges**: `ThreadPoolExecutor` breaks context tracking (async works fine), SQLite can hit lock contention under high concurrency, and custom/local models need manual pricing setup via `set_model_pricing`.
- **Experimental**: Token budgets, prompt regression diffs, tool selection, FOV capture, and MCP ingest.

## Built with

- Python 3.10+
- SQLite
- LiteLLM

## How to run

1. Install the package:

```bash
pip install swarmtrace
```

2. Add `@observe` to your function:

```python
import swarmtrace

swarmtrace.init()

@swarmtrace.observe
def my_agent(prompt):
    ...
```

3. Check your terminal:

```bash
swarmtrace
```
credit ravi

