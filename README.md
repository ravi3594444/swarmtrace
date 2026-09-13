SwarmTrace

Tracing for AI agents. Decorate a function, see the whole call tree (latency, tokens, cost, errors) in your terminal or on a dashboard.

PyPI · Dashboard · Docs



The problem

An agent that calls a model, then a tool, then another agent is a black box when it goes wrong. You get a final answer and no idea which step was slow, which one burned the tokens, or which one quietly returned garbage that everything after it built on. Print statements don't survive nesting, and most tracing tools want you to adopt their framework first.

What it does

pip install swarmtrace



import swarmtrace

swarmtrace.init()



@swarmtrace.observe

def my_agent(prompt):

...



swarmtrace # the call tree for your last runs



init() patches whichever LLM clients you already have installed, so model calls inside your agent get recorded on their own and attributed to it. Nothing to configure, no framework to adopt. Everything lands in a local SQLite file first, so it works with no network; add an API key and traces also go to the dashboard. Multi-agent runs show up as separate nodes with the handoffs drawn between them.

Status

Working:

@observe and automatic LLM patching — OpenAI, Anthropic, Gemini, LiteLLM

Local SQLite storage, offline, capped at 10k rows with age-based purging

CLI: view, replay, export to JSON/CSV, resync

Async, including asyncio.gather

Dashboard with live agent cards and node map

Cost tracking via LiteLLM's pricing registry

Rough:

ThreadPoolExecutor breaks attribution. Context rides on contextvars, which thread pools don't propagate, so spans from ex.map() / ex.submit() become their own top-level traces instead of rolling into the agent. Async is fine; this isn't.

Under fast concurrent writes SQLite lock contention prints database table is locked and that span is dropped, not retried.

Traces queued for the dashboard may not survive a process that exits immediately — delivery is on a background thread. swarmtrace-resync recovers anything that reached SQLite.

@observe costs ~0.14 ms per call (2,000 calls, local only, no delivery).

PII redaction before upload is regex-based and best-effort.

Local and fine-tuned models show zero cost until you call set_model_pricing.

Experimental — usable but not hardened: token budgets, prompt regression diffing, tool selection, FOV capture (HTTP, filesystem, screenshots), MCP ingest for agents that can't run the Python package. See docs/.

Python 3.10+. No JS/TS SDK.

Why I built it

because when i built agents by using frame works like crew ai lang graph i have no idea what was going under the hood thats why i built these project i know some things is left but i will improve it and i have a old laptop thats why i can't work in recent

License

MIT. Built by Ravi Kumar.


