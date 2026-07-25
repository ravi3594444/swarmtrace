<div align="center">

# SwarmTrace

**Observability for AI agents — trace, debug, and monitor with 2 lines of code **

[![PyPI](https://img.shields.io/pypi/v/swarmtrace?style=flat-square&color=black)](https://pypi.org/project/swarmtrace/)
[![Python](https://img.shields.io/badge/python-3.10%2B-black?style=flat-square)](https://pypi.org/project/swarmtrace/)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Built at AMD Hackathon](https://img.shields.io/badge/built%20at-AMD%20Hackathon%202026-red?style=flat-square)](https://github.com/ravi3594444/swarmtrace)

[Dashboard](https://swarmtrace.vercel.app) · [PyPI](https://pypi.org/project/swarmtrace/) · [GitHub](https://github.com/ravi3594444/swarmtrace)

</div>

---

## Install

```bash
pip install swarmtrace
```

---

## Quick Start

```python
from swarmtrace import observe

@observe
def my_agent(question):
    return llm.chat(question)

my_agent("What is machine learning?")
```

```bash
swarmtrace    # view traces in terminal
```

Every call is recorded — latency, tokens, cost, errors. Nothing else to configure.

---

## Architecture

SwarmTrace is organized around a small ports-and-adapters core: public APIs and
protocol ingress (`@observe`, `run()`/`span()`, MCP, OTLP) create canonical
`SpanRecord`s, the runtime persists them locally, and delivery adapters batch
them to the dashboard when remote ingest is configured. The Traces page also
includes an **Architecture** view that summarizes a run as agent, LLM, tool,
retrieval, and function layers. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the module map, dependency rules, data flows, and extension guidelines.

---

## Single Agent

Wrap your agent with `@observe`. Any LLM or tool calls inside it get tagged with `kind="llm"` or `kind="tool"` so they roll up into the agent's stats — they never appear as phantom agents on the dashboard.

```python
from swarmtrace import observe, init

init(api_key="your-key", endpoint="https://swarmtrace.vercel.app")

@observe
def my_agent(query):
    plan = call_llm(query)
    return search_web(plan)

@observe(kind="llm")
def call_llm(prompt):
    return client.chat(model="gpt-4o-mini", messages=[...])

@observe(kind="tool")
def search_web(q):
    ...
```

**One agent card on the dashboard.** `call_llm` and `search_web` fold their tokens, cost, and errors into `my_agent` — they never get their own card.

---

## Quickstart — inject into any agent in 2 lines

```python
import swarmtrace
swarmtrace.init()              # auto-detects OpenAI, Anthropic, Gemini, LiteLLM
```

That's all. Now decorate your top-level function:

```python
@swarmtrace.observe
def my_agent(prompt):
    return openai_client.chat.completions.create(...)  # traced automatically
```

`swarmtrace.init()` patches installed LLM clients so every raw LLM call is
recorded as `kind="llm"` — with latency, model, tokens, and cost — and
attributed to whatever agent is currently running. You don't decorate the
LLM call. You don't pick a `kind`. You don't configure anything else.

**Single agent**

```python
import swarmtrace
swarmtrace.init()

from openai import OpenAI
client = OpenAI()

@swarmtrace.observe                    # one decorator. that's it.
def my_agent(prompt):
    return client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
    )

my_agent("What is AGI?")
```

Dashboard: one "my_agent" card with tokens, cost, latency, error rate.

**Multi-agent swarm**

```python
import swarmtrace
swarmtrace.init()

@swarmtrace.observe                    # own card on the dashboard
def researcher(q):
    return client.chat.completions.create(model="gpt-4o-mini", messages=[...])

@swarmtrace.observe                    # own card
def summarizer(text):
    return client.chat.completions.create(model="gpt-4o-mini", messages=[...])

@swarmtrace.observe                    # own card — orchestrator
def orchestrator(q):
    research = researcher(q)
    return summarizer(research)

orchestrator("Explain transformers")
```

Dashboard: three cards. `researcher`'s and `summarizer`'s LLM costs roll
into their own cards automatically.

**Auto-detection** — `@observe` figures out the role at call time:
- Nothing running yet → this call **is** the agent (gets its own card).
- Already inside an agent → rolls up into it (tokens + errors fold in,
  no extra card).

So `@observe` everywhere is safe — helpers and inner calls just disappear
into the agent that ran them, instead of cluttering the Agents page.

**Need separate cards for named sub-agents?** Add `kind="agent"` explicitly:

```python
@swarmtrace.observe(kind="agent")
def researcher(q): ...
```

That's the only knob. `kind="llm"` / `kind="tool"` exist for labeling,
but the dashboard works correctly without them.

---

Every bare `@observe` is its own agent card. Nesting is handled automatically via contextvars — no IDs, no config.

```python
from swarmtrace import observe

@observe
def researcher(q):
    return call_llm(f"Research: {q}")

@observe
def summarizer(text):
    return call_llm(f"Summarize: {text}")

@observe
def orchestrator(q):
    research = researcher(q)
    return summarizer(research)

orchestrator("What is AGI?")
```

```
▶ orchestrator    4.2s  |  7 in / 78 out   |  $0.0003
  ▶ researcher    3.4s  |  7 in / 330 out  |  $0.0013
  ▶ summarizer    0.8s  |  338 in / 78 out |  $0.0005
```

Three agent cards on the dashboard — one per named agent. Sub-calls (`call_llm`) fold into whichever agent invoked them.

---

## Span Kinds

| Kind | Decorator | Dashboard |
|---|---|---|
| `agent` | `@observe` (default) | Own card — tasks, tokens, cost, status |
| `llm` | `@observe(kind="llm")` | Rolls up into calling agent |
| `tool` | `@observe(kind="tool")` | Rolls up into calling agent |
| `function` | `@observe(kind="function")` | Rolls up into calling agent |

The rule: **only functions you want as separate dashboard cards get bare `@observe`.** Everything else gets a `kind=`.

---

## Span Kinds — agents vs. tool/LLM calls

By default, `@observe` marks a call as `kind="agent"` — it gets its own
entry on the dashboard's Agents page, with its own task count, tokens,
cost, and status. That's the right default for named agents like
`orchestrator`, `researcher`, and `summarizer` above.

If you also wrap raw LLM or tool calls with `@observe` for visibility,
tag them so they roll up into the calling agent's stats instead of
showing up as their own (fake) agents:

```python
from swarmtrace import observe

@observe(kind="llm")
def call_llm(prompt):
    return client.chat(model="gpt-4o-mini", messages=[...])

@observe(kind="tool")
def search_web(query):
    ...

@observe(kind="function")
def helper(x):
    ...

@observe                      # kind="agent" (default)
def researcher(q):
    return call_llm(f"Research: {q}")
```

`call_llm` and `search_web` are attributed to whichever `kind="agent"`
call is currently running (`researcher`, here) — their tokens, cost, and
any errors are folded into `researcher`'s stats. They never appear as
separate entries on the Agents page, no matter how deeply nested.

---

## Async Support

```python
import asyncio
from swarmtrace import observe

@observe
async def async_agent(q):
    return await llm.achat(q)

@observe
async def orchestrator(q):
    results = await asyncio.gather(
        async_agent(q),
        async_agent(q + " — deep dive"),
    )
    return " | ".join(results)

asyncio.run(orchestrator("Explain transformers"))
```

---

## Live Cost Tracking

Automatic cost calculation for any model from any provider — powered by LiteLLM's live pricing registry.

```python
@observe
def agent(q):
    # OpenAI, Anthropic, Google, Mistral, DeepSeek,
    # Groq, Cohere, xAI — cost tracked automatically
    return client.chat(model="gpt-4o-mini", messages=[...])
```

Custom or fine-tuned models:

```python
from swarmtrace import set_model_pricing

set_model_pricing("my-finetune", input_per_million=5.00, output_per_million=15.00)
```

---

## Token Budget

Stop runaway agents before they burn your budget.

```python
from swarmtrace import observe, budget

@observe
@budget(max_tokens=10_000, on_exceed="warn")   # or "stop"
def agent(q):
    return llm.chat(q)
```

---

## Regression Detection

Catch when a prompt change breaks your agent's behavior.

```bash
pip install swarmtrace[regression]
```

```python
from swarmtrace.regression import compare

compare(
    my_agent,
    inputs=["What is ML?", "How does Python work?", "What is an API?"],
    version_a_prompt="You are a helpful assistant.",
    version_b_prompt="Reply only in emojis.",
    threshold=0.6,
)
```

```
INPUT                    SIMILARITY   REGRESSION?
What is ML?              0.10         🔴 YES
How does Python work?    0.15         🔴 YES
What is an API?          0.12         🔴 YES

Result: 3/3 regressions detected
```

---

## Tool Attention

Reduce token overhead by up to 95% — only pass relevant tools to each agent call, scored via ISO Scoring (arXiv:2604.21816).

```bash
pip install swarmtrace[tools]
```

```python
from swarmtrace import ToolAttention

ta = ToolAttention(tools=all_my_tools)

@observe
def agent(query):
    relevant_tools = ta.select(query, top_k=3)
    return llm.chat(query, tools=relevant_tools)
```

---

## Remote Dashboard

Send traces to the [SwarmTrace dashboard](https://swarmtrace.vercel.app) for live monitoring.

```python
from swarmtrace import init, observe

init(
    api_key="your-swarmtrace-api-key",
    endpoint="https://swarmtrace.vercel.app",
)

@observe
def my_agent(q):
    ...
```

Or via environment variables:

```bash
export SWARMTRACE_API_KEY=your-key
export SWARMTRACE_ENDPOINT=https://swarmtrace.vercel.app
```

---

## Browser & Extended Capture (FOV)

`@observe` and `init()` already trace LLM calls with zero extra dependencies — that works on a laptop, Kaggle, Colab, or a serverless function with nothing else installed. `fov=True` adds a second, opt-in layer: outbound HTTP calls, live LLM token streaming, and filesystem writes.

```python
from swarmtrace import init, observe

init(api_key="your-key", endpoint="https://swarmtrace.vercel.app", fov=True)
```

Browser screenshots are the one FOV capability that needs an actual browser, so they're opt-in on top of opt-in:

```bash
pip install swarmtrace[fov]
playwright install chromium
```

No Playwright? `fov=True` still gives you HTTP/stream/filesystem capture — screenshots are just silently skipped. Either way, `init()` prints one line to stderr telling you exactly what's active, so you're never guessing what a given machine is actually tracing.

---

## Use via MCP — no Python SDK required

Any MCP-compatible client (Claude Desktop, Cursor, Hermes, etc.) can send traces straight to SwarmTrace over HTTP, without installing the Python package at all. This is the zero-install path for agents running somewhere you don't control.

```json
{
  "mcpServers": {
    "swarmtrace": {
      "url": "https://swarmtrace.vercel.app/api/mcp",
      "headers": { "x-api-key": "your-swarmtrace-api-key" }
    }
  }
}
```

Exposes three tools: `record_trace` (send one trace), `get_metrics` (your usage stats), `list_traces` (recent traces). Exact config keys vary by client — check your client's docs for where remote/HTTP MCP servers go.

---

## CLI

```bash
swarmtrace                       # last 100 traces
swarmtrace --limit 50            # last 50
swarmtrace-replay <id>           # replay any trace
swarmtrace-export --format json
swarmtrace-export --format csv
```

---

## vs LangSmith

| Feature | SwarmTrace | LangSmith |
|---|---|---|
| Open source | ✅ | ❌ |
| Works offline | ✅ | ❌ |
| Any LLM / any framework | ✅ | ❌ LangChain only |
| Live cost tracking | ✅ all models | ✅ |
| Regression detection | ✅ | ❌ |
| Token budget enforcement | ✅ | ❌ |
| Tool attention (ISO) | ✅ | ❌ |
| Setup | 2 lines | SDK + account |
| Price | Free | $20/month |

---

## Optional Extras

```bash
pip install swarmtrace[regression]   # AI regression detection
pip install swarmtrace[tools]        # Tool attention + FAISS
pip install swarmtrace[budget]       # Token budget with tiktoken
pip install swarmtrace[scraper]      # Web scraping traces
pip install swarmtrace[fov]          # Browser screenshots (playwright + watchdog)
pip install swarmtrace[all]          # Everything
```

---

## AMD MI300X Benchmarks

Tested on AMD Instinct MI300X 192GB via AMD Developer Cloud.

| Metric | Value |
|---|---|
| Swarms tested | 5 |
| Total agent calls | 20 |
| Avg orchestrator latency | 6.1s |
| Avg researcher latency | 1.8s |
| Trace overhead | < 1ms |

---

<div align="center">

Built with ❤️ at AMD Hackathon 2026 by [Ravi Kumar](https://raviportfollio.vercel.app)

</div>
