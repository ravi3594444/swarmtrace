import os
import time
from litai import LLM

llm = LLM(
    model="anthropic/claude-haiku-4-5-20251001",
    api_key=os.environ.get("LIGHTNING_API_KEY"),
)


def score_similarity(output_a: str, output_b: str) -> float:
    """Use AI to score how similar two outputs are. Returns 0.0–1.0."""
    prompt = f"""Compare these two AI outpcat > /tmp/live_demo.py << 'PYEOF'
import os, time, threading
from litai import LLM
from tracely import observe
from tracely.budget import budget
from tracely.tool_attention import ToolAttention
from tracely.storage import get_traces
import requests
from bs4 import BeautifulSoup

os.environ.setdefault("LIGHTNING_API_KEY", os.environ.get("LIGHTNING_API_KEY", ""))
llm = LLM(model="anthropic/claude-haiku-4-5-20251001", api_key=os.environ.get("LIGHTNING_API_KEY"))

# ── LIVE STATS PRINTER ─────────────────────────────────
def print_live_stats():
    traces = get_traces(limit=50)
    if not traces:
        return
    total_cost = sum(t[10] or 0 for t in traces)
    total_tokens = sum((t[8] or 0) + (t[9] or 0) for t in traces)
    errors = sum(1 for t in traces if t[6])
    print(f"\n{'='*65}")
    print(f"  LIVE SWARMTRACE STATS")
    print(f"{'='*65}")
    print(f"  Agents traced : {len(traces)}")
    print(f"  Total tokens  : {total_tokens:,}")
    print(f"  Total cost    : ${round(total_cost, 4)}")
    print(f"  Errors caught : {errors}")
    print(f"{'='*65}")
    roots = [t for t in traces if not t[1]]
    for r in roots[-3:]:
        print(f"  ▶ {r[2]:<25} {r[5]}s | ${r[10] or 0}")
        children = [t for t in traces if t[1] == r[0]]
        for c in children:
            status = "ERROR" if c[6] else "OK"
            print(f"    └── {c[2]:<21} {c[5]}s | ${c[10] or 0} | {status}")
    print(f"{'='*65}\n")

# ── SWARM 1: NEWS RESEARCH SWARM ───────────────────────
@observe
def news_scraper(url):
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text(separator=" ", strip=True)[:2000]

@observe
def news_analyzer(text, topic):
    return llm.chat(f"From this news content, extract 3 key insights about {topic}:\n{text[:800]}")

@observe
def news_summarizer(analysis):
    return llm.chat(f"Write a 2-sentence executive summary:\n{analysis}")

@observe
@budget(max_tokens=3000, warn_at=0.7)
def news_swarm(topic):
    print(f"\n[SWARM 1] News Research: {topic}")
    raw = news_scraper("https://news.ycombinator.com")
    analysis = news_analyzer(raw, topic)
    summary = news_summarizer(analysis)
    return summary

# ── SWARM 2: FACT CHECK SWARM ──────────────────────────
@observe
def claim_extractor(topic):
    return llm.chat(f"Generate 2 bold claims about: {topic}. Format: 'CLAIM: ...'")

@observe
def fact_verifier(claim):
    results = requests.get(
        f"https://html.duckduckgo.com/html/?q=fact+check+{claim[:50].replace(' ', '+')}",
        headers={"User-Agent": "Mozilla/5.0"}, timeout=8
    ).text
    soup = BeautifulSoup(results, "html.parser")
    snippets = " ".join([r.get_text() for r in soup.find_all("a", class_="result__a", limit=3)])
    return llm.chat(f"Fact check: '{claim}'\nEvidence: {snippets[:500]}\nVerdict: TRUE/FALSE/UNCERTAIN + reason")

@observe
def verdict_writer(claims, verdicts):
    combined = "\n".join([f"Claim: {c}\nVerdict: {v}" for c, v in zip(claims, verdicts)])
    return llm.chat(f"Write a fact-check report:\n{combined}")

@observe
@budget(max_tokens=3000, warn_at=0.7)
def factcheck_swarm(topic):
    print(f"\n[SWARM 2] Fact Check: {topic}")
    claims_text = claim_extractor(topic)
    claims = [l.replace("CLAIM:", "").strip() for l in claims_text.split("\n") if "CLAIM:" in l][:2]
    if not claims:
        claims = [claims_text[:100]]
    verdicts = [fact_verifier(c) for c in claims]
    return verdict_writer(claims, verdicts)

# ── SWARM 3: COMPETITIVE ANALYSIS SWARM ────────────────
@observe
def competitor_researcher(name):
    return llm.chat(f"In 3 bullet points, what are the strengths of {name} as an AI observability tool?")

@observe
def gap_analyzer(competitors_data):
    return llm.chat(f"Based on these competitor analyses:\n{competitors_data}\n\nWhat gaps exist that swarmtrace fills?")

@observe
def pitch_writer(gaps):
    return llm.chat(f"Write a 3-sentence investor pitch for swarmtrace based on these gaps:\n{gaps}")

@observe
@budget(max_tokens=3000, warn_at=0.7)
def competitive_swarm():
    print(f"\n[SWARM 3] Competitive Analysis")
    competitors = ["LangSmith", "Arize AI", "Weights & Biases"]
    analyses = [competitor_researcher(c) for c in competitors]
    combined = "\n\n".join([f"{c}:\n{a}" for c, a in zip(competitors, analyses)])
    gaps = gap_analyzer(combined)
    return pitch_writer(gaps)

# ── TOOL ATTENTION ─────────────────────────────────────
def show_tool_attention():
    print(f"\n[TOOL ATTENTION] Demonstrating 95% token reduction...")
    tools = [
        {"name": "web_search", "description": "Search the web for information", "schema": {"query": "string"}},
        {"name": "code_exec", "description": "Execute Python code in sandbox", "schema": {"code": "string"}},
        {"name": "image_gen", "description": "Generate images from text prompts", "schema": {"prompt": "string"}},
        {"name": "send_email", "description": "Send email to recipient", "schema": {"to": "string", "body": "string"}},
        {"name": "db_query", "description": "Query SQL database", "schema": {"sql": "string"}},
        {"name": "read_file", "description": "Read file contents from disk", "schema": {"path": "string"}},
        {"name": "write_file", "description": "Write content to file", "schema": {"path": "string"}},
        {"name": "api_call", "description": "Make HTTP API request", "schema": {"url": "string"}},
        {"name": "translate", "description": "Translate text to another language", "schema": {"text": "string"}},
        {"name": "calendar", "description": "Check or create calendar events", "schema": {"date": "string"}},
    ]
    ta = ToolAttention(tools=tools)
    print("\nQuery: 'write and run a python script'")
    ta.select("write and run a python script", k=3)
    print("\nQuery: 'search database for user records'")
    ta.select("search database for user records", k=3)
    print("\nQuery: 'generate an image of a sunset'")
    ta.select("generate an image of a sunset", k=3)

# ── MAIN RUNNER ────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "="*65)
    print("  SWARMTRACE LIVE DEMO — Multi-Swarm AI Agent System")
    print("  github.com/ravi3594444/swarmtrace")
    print("="*65)

    # Show Tool Attention first
    show_tool_attention()

    print("\n" + "="*65)
    print("  LAUNCHING 3 PARALLEL SWARMS")
    print("="*65)

    # Run all 3 swarms
    r1 = news_swarm("AI agent frameworks")
    print_live_stats()

    r2 = factcheck_swarm("artificial intelligence")
    print_live_stats()

    r3 = competitive_swarm()
    print_live_stats()

    # Final results
    print("\n" + "="*65)
    print("  FINAL RESULTS")
    print("="*65)
    print(f"\n[SWARM 1] News Summary:\n{r1}\n")
    print(f"\n[SWARM 2] Fact Check:\n{r2[:300]}...\n")
    print(f"\n[SWARM 3] Pitch:\n{r3}\n")

    print("="*65)
    print("  FINAL SWARMTRACE STATS")
    print("="*65)
    traces = get_traces(limit=100)
    total_cost = sum(t[10] or 0 for t in traces)
    total_tokens = sum((t[8] or 0) + (t[9] or 0) for t in traces)
    print(f"  Total agents traced : {len(traces)}")
    print(f"  Total tokens used   : {total_tokens:,}")
    print(f"  Total cost          : ${round(total_cost, 4)}")
    print(f"  Errors caught       : {sum(1 for t in traces if t[6])}")
    print(f"\n  All captured with @observe — zero manual logging")
    print(f"  pip install swarmtrace")
    print("="*65)
PYEOF
echo "created!"uts and return ONLY a number between 0.0 and 1.0.
1.0 = identical meaning. 0.0 = completely different.

Output A: {output_a[:300]}
Output B: {output_b[:300]}

Reply with just the number, nothing else."""
    score = llm.chat(prompt).strip()
    try:
        return float(score)
    except ValueError:
        return 0.5


def compare(func, inputs: list, version_a_prompt: str, version_b_prompt: str):
    """
    Compare two prompt versions against the same inputs.
    Detects regressions automatically.
    """
    print(f"\n[swarmtrace Regression] Comparing v1 vs v2 on {len(inputs)} inputs...\n")
    print(f"{'INPUT':<30} {'V1 LATENCY':<12} {'V2 LATENCY':<12} {'SIMILARITY':<12} {'REGRESSION?'}")
    print("-" * 85)

    regressions = 0

    for input_text in inputs:
        start = time.time()
        out_a = func(input_text, version_a_prompt)
        lat_a = round(time.time() - start, 2)

        start = time.time()
        out_b = func(input_text, version_b_prompt)
        lat_b = round(time.time() - start, 2)

        similarity = score_similarity(out_a, out_b)
        regressed  = similarity < 0.6
        if regressed:
            regressions += 1

        flag        = "🔴 YES" if regressed else "✅ NO"
        short_input = input_text[:28] + ".." if len(input_text) > 28 else input_text
        print(f"{short_input:<30} {str(lat_a)+'s':<12} {str(lat_b)+'s':<12} {str(similarity):<12} {flag}")

    print(f"\n{'='*85}")
    print(f"Result: {regressions}/{len(inputs)} regressions detected")
    if regressions > 0:
        print("⚠️  WARNING: Your new prompt may have regressed!")
    else:
        print("✅ No regressions. Safe to ship.")
    print()