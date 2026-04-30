import os, sys
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")

from litai import LLM
from tracely.tracer import observe

llm = LLM(model="anthropic/claude-haiku-4-5-20251001", api_key=os.environ.get("LIGHTNING_API_KEY"))

@observe
def ask(question):
    return llm.chat(question)

print(ask("What is observability in AI?"))
