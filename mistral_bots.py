"""
Multi-agent LLM swarm utilizing SwarmTrace observability to find bugs in code.
Uses Mistral's API key and open-mistral-nemo model via the openai client.
"""

import os
import sys
from openai import OpenAI
import swarmtrace

# Initialize SwarmTrace
swarmtrace.init()

# Check for API key
api_key = os.environ.get("MISTRAL_API_KEY")
if not api_key:
    print("Error: MISTRAL_API_KEY environment variable is not set.", file=sys.stderr)
    sys.exit(1)

# Configure OpenAI-compatible Mistral Client
client = OpenAI(
    api_key=api_key,
    base_url="https://api.mistral.ai/v1"
)

# Model configuration
MODEL = "open-mistral-nemo"


@swarmtrace.observe
def developer_bot(code: str) -> str:
    """Analyze code and identify any potential bugs/flaws."""
    print("[Developer Bot] Analyzing code for bugs...")
    prompt = (
        f"You are an expert security researcher and developer. "
        f"Analyze the following code block for bugs, memory leaks, and vulnerabilities. "
        f"Return a list of specific findings.\n\n"
        f"Code:\n```python\n{code}\n```"
    )

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Be precise and analytical."},
            {"role": "user", "content": prompt}
        ]
    )
    analysis = response.choices[0].message.content
    print("[Developer Bot] Analysis complete.")
    return analysis


@swarmtrace.observe
def reviewer_bot(analysis: str) -> str:
    """Review the developer's findings and suggest specific, robust code fixes."""
    print("[Reviewer Bot] Reviewing findings and compiling suggestions...")
    prompt = (
        f"Review the following bug analysis findings and suggest exact, robust fixes "
        f"with corrected code snippets.\n\n"
        f"Analysis findings:\n{analysis}"
    )

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "Provide direct and helpful Python fixes."},
            {"role": "user", "content": prompt}
        ],
        stream=True,
        stream_options={"include_usage": True}
    )

    # Iterate and stream the response to verify SwarmTrace's stream instrumentation
    full_response = []
    for chunk in response:
        content = chunk.choices[0].delta.content if chunk.choices else ""
        if content:
            full_response.append(content)

    print("[Reviewer Bot] Review complete.")
    return "".join(full_response)


@swarmtrace.observe
def orchestrator_bot(code_to_audit: str) -> str:
    """Orchestrate the multi-agent bug finding pipeline."""
    print("[Orchestrator Bot] Starting multi-agent bug finding pipeline...")

    # 1. Developer analyzes the code
    findings = developer_bot(code_to_audit)

    # 2. Reviewer checks findings and proposes fixes
    report = reviewer_bot(findings)

    print("[Orchestrator Bot] Swarm execution completed successfully!")
    return f"=== DETECTED BUGS ===\n{findings}\n\n=== SUGGESTED FIXES ===\n{report}"


@swarmtrace.observe
def run_error_simulation():
    """Trigger a forced exception to test key-redaction and error tracing in SwarmTrace."""
    print("[Error Simulation] Making invalid API call (invalid model) to test error path...")
    try:
        client.chat.completions.create(
            model="non-existent-model-to-trigger-error",
            messages=[{"role": "user", "content": "Hi"}]
        )
    except Exception as exc:
        print(f"[Error Simulation] Caught expected error: {exc}")
        # Re-raise so that the agent's observe decorator catches the error too
        raise


if __name__ == "__main__":
    test_code = """
def process_user_data(data):
    # Bug 1: No verification if list index exists
    user_id = data[0]

    # Bug 2: SQL Injection risk
    query = f"SELECT * FROM users WHERE id = '{user_id}'"
    execute_sql(query)

    # Bug 3: File handle leak
    f = open("log.txt", "w")
    f.write(f"Processed {user_id}")
    # f.close() is missing!
"""

    print("=================== STARTING SWARMTRACE MISTRAL BOTS ===================")
    # Run Orchestrator Pipeline
    final_report = orchestrator_bot(test_code)
    print("\n=================== FINAL REPORT ===================")
    print(final_report)
    print("====================================================\n")

    # Run Error Simulation
    try:
        run_error_simulation()
    except Exception:
        print("[Main] Error simulation completed.")

    print("\n=================== ALL BOTS RUN FINISHED ===================")
