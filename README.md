
# swarmtrace

pytest for AI agents — trace, debug and catch regressions in LLM swarms

## Install
pip install swarmtrace

## Quick Start
from tracely import observe

@observe
def my_agent(question):
    return llm.chat(question)

## CLI Commands
swarmtrace                          # view all traces with rich colors
swarmtrace-replay <id>              # replay any trace
swarmtrace-export --format json     # export to JSON
swarmtrace-export --format csv      # export to CSV

## Features
- One decorator, zero config
- Multi-agent swarm tracing with parent/child tree
- Async + sync support
- Thread-safe (contextvars)
- Accurate token counting via tiktoken
- Cost tracking per agent
- Regression detection
- Failure replay
- Works with any LLM

## Built at AMD Hackathon 2026
