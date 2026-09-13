# swarmtrace

Tracing for AI agents. Add a decorator, get latency, tokens, cost and errors for every one of your calls - in the terminal or on the dashboard.

[PyPI](https://pypi.org/project/swarmtrace/) · [Dashboard](https://swarmtrace.vercel.app) · [Architecture](docs/ARCHITECTURE.md)

![SwarmTrace dashboard](docs/images/dashboard.png)

## Install

```bash
pip install swarmtrace
```

Python 3.10+. MIT licensed.

## Quick start

```python
import swarmtrace

swarmtrace.init()     # patch OpenAI, Anthropic, Gemini, LiteLLM if installed

@swarmtrace.observe
def my_agent(prompt):
return client.chat.completions.create(
model="gpt-4o-mini",
messages=[{"role": "user", "content": prompt}],
)

my_agent("What is AGI?")
```

```bash
swarmtrace         # print last 100 traces as a table + call tree
```

LLMs called in `my_agent` are recorded and attributed to it, automatically. You do not decorate the calls to them.

## Why I built this
<!--

Write 4-6 sentences here yourself. The reviewer will read this section first.
Answer these, concretely:
- What were you building when you needed this? What went wrong?
- What did you use before -- print statements, LangSmith, nothing?
- Why didn't that work for you specifically?
Do NOT write "observability for agents is hard." Write what you saw on your
screen.
-->

## How it works

`@observe` opens a span and closes it when the function returns. `init()` monkey-patches installed LLM clients to make the raw model calls into spans as well. Spans are written, first, to a local store -- everything is offline-explorable -- but if you call `init()` with an API key they are also batched up to the dashboard. Ingress from MCP and OTLP produces identical spans to the decorator's output.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module map and data flow.

### Span kinds

`@observe` defaults to `kind="agent"`, which gets its own card on the dashboard. Tag everything else so it rolls up into the agent that called it, rather than appearing under "agents":

| Kind | Decorator | Dashboard |
|---|---|---|
| `agent` | `@observe` | Own card -- tasks, tokens, cost, status |
| `llm` | `@observe(kind="llm")` | Rolls up into calling agent |
| `tool` | `@observe(kind="tool")` | Rolls up into calling agent |
| `function` | `@observe(kind="function")` | Rolls up into calling agent |

Async functions behave equivalently: `@observe` on an `async def` is fine, including under `asyncio.gather`.

## CLI

```bash
swarmtrace            # last 100 traces
swarmtrace --limit 50
swarmtrace-replay       # replay one trace in full
swarmtrace-export --format json # -> ./swarmtrace_export.json
swarmtrace-resync        # re-send traces the dashboard never received
swarmtrace-alerts list
```

Every command takes `--help`. They exit 0 on success, 1 on a genuine error (unwritable export path, traces still refusing resync), and 2 on bad args, making them safe to use in scripts and CI.

## Dashboard

```bash
export SWARMTRACE_API_KEY=your-key
export SWARMTRACE_ENDPOINT=https://swarmtrace.vercel.app
```

If your traces are never seen, a common symptom is a self-hosted Supabase without the migrations in [`supabase/migrations/`](supabase/migrations): every ingest call returns 500. `GET /api/health/db` states which migration is missing. Setup is at [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## Without the Python SDK

Any MCP client may post traces over HTTP:

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

Three tools: `record_trace`, `get_metrics`, `list_traces`.

## Optional extras

```bash
pip install swarmtrace[regression]  # prompt version diffing for behaviour drift
pip install swarmtrace[budget]    # token ceilings per agent, warn or stop
pip install swarmtrace[tools]    # tool selection by relevance
pip install swarmtrace[fov]     # HTTP, stream and filesystem capture + screenshots
pip install swarmtrace[all]
```

Each is documented in [docs/](docs/).

## Limitations
<!--

Fill this in yourself. This is the section that provdes you shipped it.
Suggestions, answer honestly:
- How many spans before the local store gets slow?
- Does FOV screenshot capture actually work reliably, or is it flaky?
- What happens with threads / high concurrency?
- Which LLM clients are auto-patched well and which are partial?
- What's the overhead, and how did you measure it?
-->

## License

MIT. Built by [Ravi Kumar](https://raviportfollio.vercel.app).
