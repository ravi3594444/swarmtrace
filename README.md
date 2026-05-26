# SwarmTrace 🐝

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue?style=for-the-badge&logo=python" />
  <img src="https://img.shields.io/badge/pytest-ready-green?style=for-the-badge&logo=pytest" />
  <img src="https://img.shields.io/badge/LLM-Swarm-purple?style=for-the-badge" />
</p>

> **Pytest framework for AI Multi-Agents** — trace, debug, and catch regressions in LLM swarms.

Built for the **AMD Hackathon**, SwarmTrace brings software engineering rigor to agentic AI systems. Test your multi-agent workflows like you test your code.

---

## 🎯 Why SwarmTrace?

LLM agents are unpredictable. SwarmTrace gives you:

- ✅ **Trace agent reasoning** — see every decision, tool call, and output
- ✅ **Catch regressions** — when agent behavior changes unexpectedly
- ✅ **Debug failures** — pinpoint exactly where the swarm broke
- ✅ **CI/CD ready** — integrates with any pytest pipeline

---

## 📦 Installation

```bash
git clone https://github.com/ravi3594444/swarmtrace.git
cd swarmtrace
pip install -r requirements.txt
```

## 🚀 Quick Start

```python
from swarmtrace import SwarmTest, Agent

# Define your agent
agent = Agent(name="researcher", model="gpt-4")

# Write a test
def test_research_accuracy():
    result = agent.run("What is the capital of France?")
    assert "Paris" in result.output
    assert result.latency < 5.0  # seconds
```

---

## 🛠️ Tech Stack

- **Python 3.10+**
- **pytest** — test framework
- **LangChain / custom agent orchestration**
- **OpenAI / Anthropic / Local LLM APIs**

---

## 📝 License

MIT — built by [Ravi Kumar](https://raviportfollio.vercel.app)
