<div align="center">

# SwarmTrace

**The observability platform for AI agents**

[![PyPI](https://img.shields.io/pypi/v/swarmtrace?style=flat-square&color=black)](https://pypi.org/project/swarmtrace/)
[![Python](https://img.shields.io/badge/python-3.10%2B-black?style=flat-square)](https://pypi.org/project/swarmtrace/)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Built at AMD Hackathon](https://img.shields.io/badge/built%20at-AMD%20Hackathon%202026-red?style=flat-square)](https://github.com/ravi3594444/swarmtrace)

Trace, debug, and catch regressions in LLM swarms — with 2 lines of code.

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
from tracely import observe

@observe
def my_agent(question):
    return llm.chat(question)

my_agent("What is machine learning?")
```

```bash
swarmtrace          # view traces in terminal
```

That's it. Every call is traced — latency, tokens, cost, errors.

---

## Multi-Agent Swarms

Nested agents are tracked automatically. Parent-child relationships are preserved.

```python
from tracely import observe

@observe
def researcher(q):
    return llm.chat(f"Research: {q}")

@observe
def summarizer(text):
    return llm.chat(f"Summarize: {text}")

@observe
def orchestrator(q):
    research = researcher(q)
    return summarizer(research)

orchestrator("What is AGI?")
```

```
▶ orchestrator          4.2s  |  7 in / 78 out  |  $0.0003
  ▶ researcher          3.4s  |  7 in / 330 out  |  $0.0013
  ▶ summarizer          0.8s  |  338 in / 78 out  |  $0.0005
```

---

## Async Support

```python
import asyncio
from tracely import observe

@observe
async def async_agent(q):
    return await llm.achat(q)

@observe
async def orchestrator(q):
    results = await asyncio.gather(
        async_agent(q),
        async_agent(q + " — deep dive")
    )
    return " | ".join(results)

asyncio.run(orchestrator("Explain transformers"))
```

---

## Live Cost Tracking

SwarmTrace automatically calculates cost for **any model** from any provider — powered by the LiteLLM live pricing registry, refreshed every hour.

```python
from tracely import observe

@observe
def agent(q):
    # works with OpenAI, Anthropic, Google, Mistral,
    # DeepSeek, Groq, Cohere, xAI — any model
    return client.chat(model="gpt-4o-mini", messages=[...])
```

For custom or fine-tuned models:

```python
from tracely import set_model_pricing

set_model_pricing("my-finetune", input_per_million=5.00, output_per_million=15.00)
```

---

## Token Budget

Stop runaway agents before they burn your budget.

```python
from tracely import observe, budget

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
from tracely.regression import compare

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

Reduce token overhead by up to 95% — only pass relevant tools to each agent call, using ISO Scoring (arXiv:2604.21816).

```bash
pip install swarmtrace[tools]
```

```python
from tracely import ToolAttention

ta = ToolAttention(tools=all_my_tools)

@observe
def agent(query):
    relevant_tools = ta.select(query, top_k=3)
    return llm.chat(query, tools=relevant_tools)
```

---

## CLI

```bash
swarmtrace                     # view last 100 traces
swarmtrace --limit 50          # view last 50 traces
swarmtrace-replay <id>         # replay any trace
swarmtrace-export --format json
swarmtrace-export --format csv
```

---

## Remote Ingest + SaaS Dashboard

Send traces to your [SwarmTrace dashboard](https://swarmtrace.vercel.app) for live monitoring.

```python
from tracely import init, observe

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

## vs LangSmith

| Feature                  | SwarmTrace      | LangSmith         |
|--------------------------|-----------------|-------------------|
| Open source              | ✅              | ❌                |
| Works offline            | ✅              | ❌                |
| Any LLM / any framework  | ✅              | ❌ LangChain only |
| Live cost tracking       | ✅ all models   | ✅                |
| Regression detection     | ✅              | ❌                |
| Token budget enforcement | ✅              | ❌                |
| Tool attention (ISO)     | ✅              | ❌                |
| Setup                    | 2 lines         | SDK + account     |
| Price                    | Free            | $20/month         |

---

## Optional Extras

```bash
pip install swarmtrace[regression]   # AI regression detection
pip install swarmtrace[tools]        # Tool attention + FAISS
pip install swarmtrace[budget]       # Token budget with tiktoken
pip install swarmtrace[scraper]      # Web scraping traces
pip install swarmtrace[all]          # Everything
```

---

## AMD MI300X Benchmarks

Tested on AMD Instinct MI300X 192GB via AMD Developer Cloud.

| Metric                   | Value        |
|--------------------------|--------------|
| Swarms tested            | 5            |
| Total agent calls        | 20           |
| Avg orchestrator latency | 6.1s         |
| Avg researcher latency   | 1.8s         |
| Trace overhead           | < 1ms        |

---

<div align="center">

Built with ❤️ at AMD Hackathon 2026 by [Ravi Kumar](https://raviportfollio.vercel.app)

</div>
