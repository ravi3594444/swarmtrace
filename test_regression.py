import sys, os
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")

from litai import LLM
from tracely.regression import compare

llm = LLM(model="anthropic/claude-haiku-4-5-20251001", api_key=os.environ.get("LIGHTNING_API_KEY"))

def my_agent(question, system_prompt):
    return llm.chat(f"{system_prompt}\n\nUser: {question}")

v1 = "You are a helpful assistant. Answer clearly."
v2 = "Reply only in emojis."  # intentional regression!

inputs = [
    "What is machine learning?",
    "How does Python work?",
    "What is an API?"
]

compare(my_agent, inputs, v1, v2)
