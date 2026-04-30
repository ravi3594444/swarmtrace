import sys, os
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")

from litai import LLM
from tracely.tracer import observe

llm = LLM(model="anthropic/claude-haiku-4-5-20251001", api_key=os.environ.get("LIGHTNING_API_KEY"))

@observe
def researcher(question):
    return llm.chat(f"Research this briefly: {question}")

@observe
def summarizer(text):
    return llm.chat(f"Summarize in one line: {text}")

@observe
def orchestrator(question):
    research = researcher(question)
    summary = summarizer(research)
    return summary

orchestrator("What is quantum computing?")
