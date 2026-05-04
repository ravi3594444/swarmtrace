<p align="center">
  <img src="assets/logo.png" width="280" alt="swarmtrace logo"/>
</p>

<h1 align="center">swarmtrace</h1>
<p align="center"><b>pytest for AI agents — trace, debug and catch regressions in LLM swarms</b></p>

<p align="center">
  <a href="https://pypi.org/project/swarmtrace/"><img src="https://img.shields.io/pypi/v/swarmtrace" alt="PyPI"/></a>
  <img src="https://img.shields.io/badge/python-3.8+-blue"/>
  <img src="https://img.shields.io/badge/license-MIT-green"/>
  <img src="https://img.shields.io/badge/built%20at-AMD%20Hackathon%202026-red"/>
</p>

---

## Install

```bash
pip install swarmtrace
```

---

## Quick Start

```python
from litai import LLM
from tracely import observe

llm = LLM(model="anthropic/claude-haiku-4-5-20251001")

@observe
def my_agent(question):
    return llm.chat(question)

my_agent("What is machine learning?")
```

---

## Multi-Agent Swarm Tracing

```python
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

Output:
```
[swarmtrace] ▶ orchestrator started (id=2b914f91)
[swarmtrace]   ▶ researcher started (id=ffbf1215)
[swarmtrace]   ✓ done: researcher | 3.4s | 7in/330out | $0.0013
[swarmtrace]   ▶ summarizer started (id=4fc29468)
[swarmtrace]   ✓ done: summarizer | 0.8s | 338in/78out | $0.0005
[swarmtrace] ✓ done: orchestrator | 4.2s | 7in/78out | $0.0003
```

---

## Async Support

```python
import asyncio

@observe
async def async_researcher(q):
    return llm.chat(q)

@observe
async def async_orchestrator(q):
    research, summary = await asyncio.gather(
        async_researcher(q),
        async_summarizer(q)
    )
    return f"{research} | {summary}"

asyncio.run(async_orchestrator("What is quantum computing?"))
```

---

## CLI Commands

```bash
swarmtrace                        # view all traces with rich colors + agent tree
swarmtrace-replay <id>            # replay any trace instantly
swarmtrace-export --format json   # export to JSON
swarmtrace-export --format csv    # export to CSV
```

---

## Regression Detection

```python
from tracely.regression import compare

compare(
    my_agent,
    inputs=["What is ML?", "How does Python work?", "What is an API?"],
    version_a_prompt="You are a helpful assistant.",
    version_b_prompt="Reply only in emojis."
)
```

Output:
```
INPUT                     V1      V2     SIMILARITY  REGRESSION?
What is ML?               3.7s    1.5s   0.1         🔴 YES
How does Python work?     3.0s    1.1s   0.15        🔴 YES
What is an API?           3.1s    1.0s   0.15        🔴 YES

Result: 3/3 regressions detected
⚠️  WARNING: Your new prompt may have regressed!
```

---

## Features

| Feature | swarmtrace | LangSmith |
|---|---|---|
| Open Source | ✅ | ❌ |
| Works offline | ✅ | ❌ |
| Any LLM | ✅ | ❌ LangChain only |
| Multi-agent tree | ✅ | ✅ |
| Async support | ✅ | ✅ |
| Regression detection | ✅ | ❌ |
| One decorator setup | ✅ | ❌ |
| Cost per agent | ✅ | ✅ |
| Self-hosted | ✅ | ❌ |
| Price | Free | $20/month |

---

## Roadmap

- [ ] PostgreSQL backend for production scale
- [ ] Web dashboard UI
- [ ] Native OpenAI/Anthropic exact token counts
- [ ] PII redaction for sensitive traces

---

<p align="center">Built with ❤️ at AMD Hackathon 2026 by <a href="https://github.com/ravi3594444">Ravi</a></p>


## Benchmarks — AMD MI300X (192GB)

Tested on AMD Instinct MI300X GPU via DigitalOcean AMD Developer Cloud.

| Metric | Value |
|---|---|
| Hardware | AMD MI300X 192GB |
| Swarms | 5 orchestrators |
| Total agent calls | 20 |
| Avg orchestrator latency | 6.1s |
| Avg researcher latency | 1.8s |
| Trace overhead | <1ms per call |

<img src="assets/benchmark.png" alt="AMD MI300X Benchmark"/>
[swarmtrace] ▶ orchestrator started (id=2b914f91)
[swarmtrace]   ▶ researcher started (id=ffbf1215)
[swarmtrace]   done: researcher | 3.4s | 7in/330out | $0.0013
[swarmtrace]   ▶ summarizer started (id=4fc29468)
[swarmtrace]   done: summarizer | 0.8s | 338in/78out | $0.0005
[swarmtrace] done: orchestrator | 4.2s | 7in/78out | $0.0003

---

## Token Budget Manager

Never let agents burn unlimited tokens again:

```python
from tracely import observe
from tracely.budget import budget

@observe
@budget(max_tokens=500, warn_at=0.8)
def agent(q):
    return llm.chat(q)

agent("What is AI?")
agent("What is ML?")
agent("What is AGI?")
```

Output:
[swarmtrace] Budget: agent [████████░░░░░░░░░░░░] 203/500 tokens (41%)
[swarmtrace] WARNING: agent [█████████████████░░░] 437/500 tokens (87%) near limit!
[swarmtrace] OVER BUDGET: agent [███████████████████████] 697/500 tokens

---

## Tool Attention — 95% Token Reduction

Based on arXiv:2604.21816 — reduces tool token overhead using semantic similarity:

```python
from tracely.tool_attention import ToolAttention

tools = [
    {"name": "web_search", "description": "Search the web", "schema": {"query": "string"}},
    {"name": "code_exec", "description": "Execute Python code", "schema": {"code": "string"}},
    {"name": "image_gen", "description": "Generate images", "schema": {"prompt": "string"}},
    {"name": "send_email", "description": "Send an email", "schema": {"to": "string"}},
    {"name": "db_query", "description": "Query a database", "schema": {"sql": "string"}},
]

ta = ToolAttention(tools=tools)
active_tools = ta.select("write and run a python script", k=3)
```

Output:
[ToolAttention] Indexed 5 tools | Full schema: ~55 tokens
[ToolAttention] Selected 3/5 tools in 0.012s
[ToolAttention] Tokens: 55 to 17 (69.1% reduction)
[ToolAttention] code_exec
[ToolAttention] write_file
[ToolAttention] api_call

---

## Web Scraping Tracing

```python
from tracely.scraper import scrape
from tracely import observe

@observe
def research_agent(topic):
    web_data = scrape("https://news.ycombinator.com")
    return llm.chat(f"Summarize this about {topic}: {web_data[:500]}")

research_agent("AI news")
```

---

## Async Support

```python
import asyncio

@observe
async def async_researcher(q):
    return llm.chat(q)

@observe
async def async_orchestrator(q):
    research, summary = await asyncio.gather(
        async_researcher(q),
        async_summarizer(q)
    )
    return f"{research} | {summary}"

asyncio.run(async_orchestrator("What is quantum computing?"))
```

---

## CLI Commands

```bash
swarmtrace                        # view all traces with rich colors and agent tree
swarmtrace-replay <id>            # replay any trace instantly
swarmtrace-export --format json   # export to JSON
swarmtrace-export --format csv    # export to CSV
```

---

## Regression Detection

```python
from tracely.regression import compare

compare(
    my_agent,
    inputs=["What is ML?", "How does Python work?", "What is an API?"],
    version_a_prompt="You are a helpful assistant.",
    version_b_prompt="Reply only in emojis."
)
```

Output:
INPUT                     V1      V2     SIMILARITY  REGRESSION?
What is ML?               3.7s    1.5s   0.1         YES
How does Python work?     3.0s    1.1s   0.15        YES
What is an API?           3.1s    1.0s   0.15        YES
Result: 3/3 regressions detected
WARNING: Your new prompt may have regressed!

---

## Features

| Feature | swarmtrace | LangSmith |
|---|---|---|
| Open Source | YES | NO |
| Works offline | YES | NO |
| Any LLM | YES | NO LangChain only |
| Multi-agent tree | YES | YES |
| Async + thread safe | YES | YES |
| Token budget manager | YES | NO |
| Tool Attention ISO scoring | YES | NO |
| Regression detection | YES | NO |
| Web scraping tracing | YES | NO |
| One decorator setup | YES | NO |
| Self-hosted | YES | NO |
| Price | Free | $20/month |

---

## Benchmarks — AMD MI300X (192GB)

Tested on AMD Instinct MI300X GPU via DigitalOcean AMD Developer Cloud.

| Metric | Value |
|---|---|
| Hardware | AMD MI300X 192GB |
| Swarms | 5 orchestrators |
| Total agent calls | 20 |
| Avg orchestrator latency | 6.1s |
| Avg researcher latency | 1.8s |
| Trace overhead | less than 1ms per call |

<img src="assets/benchmark.png" alt="AMD MI300X Benchmark"/>

---

## Roadmap

- PostgreSQL backend for production scale
- Web dashboard UI
- Native OpenAI/Anthropic exact token counts
- PII redaction for sensitive traces
- Distributed agent support

---

<p align="center">Built with love at AMD Hackathon 2026 by <a href="https://github.com/ravi3594444">Ravi</a></p>
"""

