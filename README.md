# Tracely
> Open-source AI observability framework. Trace, debug and detect regressions in LLM apps with one decorator.

## Install
pip install tracely

## Usage
from tracely import observe

@observe
def my_agent(question):
    return llm.chat(question)

## Features
- One decorator, zero config
- Latency tracking
- Error capture
- AI-powered regression detection
- CLI: tracely view
- Works with any LLM

## Why Not LangSmith?
| | LangSmith | Tracely |
|---|---|---|
| Open Source | No | Yes |
| Any Framework | No | Yes |
| Self-hosted | No | Yes |
| Regression Detection | No | Yes |
| Setup | Complex | One decorator |
