"""
Local development API for SwarmTrace.

Serves traces from the tracely SQLite DB to the local dashboard.
Production ingest, auth and dashboard APIs live in frontend-next/app/api
(Next.js + Clerk + Supabase) — this server is intentionally read-only
and unauthenticated, for localhost use only.
"""

import asyncio
import json
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from tracely.storage import get_all_traces as _db_get_all_traces

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANALYSIS_FILE = Path("swarm_trace_analysis.json")

# Comma-separated list of allowed origins.
ALLOWED_ORIGINS: List[str] = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://localhost:3000"
    ).split(",")
    if o.strip()
]

FUNCTIONS = [
    "execute_task", "plan_steps", "fetch_data", "process_data",
    "analyze_results", "generate_report", "validate_input",
    "optimize_parameters", "check_constraints", "log_results",
]

ERRORS = [
    "TimeoutError: Operation exceeded time limit",
    "RateLimitError: Too many requests",
    "ValidationError: Invalid input parameters",
    "ConnectionError: Could not connect to data source",
]

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class Trace(BaseModel):
    id: str
    parent_id: Optional[str] = None
    function: str
    args: str
    output: str
    latency_sec: float
    error: Optional[str] = None
    timestamp: str
    input_tokens: int
    output_tokens: int
    cost_usd: float = Field(ge=0)

# ---------------------------------------------------------------------------
# Trace generation (demo fallback only — used when the local DB is empty)
# ---------------------------------------------------------------------------

_FUNCTION_TEMPLATES: dict = {
    "execute_task": (
        '{"task": "Analyze swarm behavior", "params": {"iterations": 100}}',
        '{"status": "completed", "result": "Analysis complete"}',
        (2.0, 5.0), (300, 800), (100, 400),
    ),
    "plan_steps": (
        '{"goal": "Optimize swarm performance"}',
        '["analyze_current_state", "identify_bottlenecks", "propose_improvements"]',
        (0.5, 1.5), (150, 400), (50, 200),
    ),
    "fetch_data": (
        '{"source": "swarm_metrics", "period": "last_24h"}',
        '{"metrics": {"agent_count": 50, "average_distance": 12.4, "cluster_score": 0.87}}',
        (1.0, 3.0), (200, 500), (100, 300),
    ),
}

def _make_trace(parent_ids: List[Optional[str]]) -> Trace:
    parent_id = random.choice(parent_ids) if random.random() < 0.7 else None
    function = random.choice(FUNCTIONS)
    trace_id = uuid.uuid4().hex

    if function in _FUNCTION_TEMPLATES:
        args, output_tpl, lat_range, in_range, out_range = _FUNCTION_TEMPLATES[function]
    else:
        value = random.randint(1, 100)
        score = round(random.uniform(0.5, 1.0), 2)
        args = f'{{"action": "{function}", "params": {{"value": {value}}}}}'
        output_tpl = f'{{"result": "{function}_completed", "score": {score}}}'
        lat_range, in_range, out_range = (0.3, 2.0), (100, 600), (50, 250)

    has_error = random.random() < 0.1
    error = random.choice(ERRORS) if has_error else None
    in_tok = random.randint(*in_range)
    out_tok = 0 if has_error else random.randint(*out_range)
    cost = round((in_tok + out_tok) * 0.000002, 6)

    return Trace(
        id=trace_id,
        parent_id=parent_id,
        function=function,
        args=args,
        output="" if has_error else output_tpl,
        latency_sec=round(random.uniform(*lat_range), 2),
        error=error,
        timestamp=datetime.now(timezone.utc).isoformat(),
        input_tokens=in_tok,
        output_tokens=out_tok,
        cost_usd=cost,
    )

def generate_trace_data(count: int = 20) -> List[Trace]:
    """Generate realistic demo trace data with parent-child hierarchy."""
    traces: List[Trace] = []
    parent_ids: List[Optional[str]] = [None]

    for _ in range(count):
        trace = _make_trace(parent_ids)
        traces.append(trace)
        if not trace.error:
            parent_ids.append(trace.id)

    return traces

# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

_trace_store: List[Trace] = []
_trace_store_lock = asyncio.Lock()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _trace_store
    _trace_store = generate_trace_data()
    yield
    _trace_store.clear()

app = FastAPI(title="SwarmTrace Local Dev API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/traces")
async def get_traces():
    """
    Return all traces wrapped in { traces: [...] } for the frontend.
    Reads from the tracely SQLite DB when traces exist; falls back to
    demo data when the DB is empty (e.g. first launch with no agents run yet).
    """
    rows = _db_get_all_traces(limit=500)

    if rows:
        return {
            "traces": [
                {
                    "id": r[0],
                    "parent_id": r[1],
                    "function": r[2],
                    "args": r[3] or "",
                    "output": r[4] or "{}",
                    "duration": int((r[5] or 0) * 1000),
                    "status": "ERROR" if r[6] else "SUCCESS",
                    "error": r[6],
                    "timestamp": r[7],
                    "tokens_in": r[8] or 0,
                    "tokens_out": r[9] or 0,
                    "cost": r[10] or 0.0,
                }
                for r in rows
            ]
        }

    # DB empty — serve demo data so the UI is not blank on first launch
    async with _trace_store_lock:
        store_snapshot = list(_trace_store)

    return {
        "traces": [
            {
                "id": t.id,
                "parent_id": t.parent_id,
                "function": t.function,
                "args": t.args,
                "output": t.output or "{}",
                "duration": int(t.latency_sec * 1000),
                "status": "ERROR" if t.error else "SUCCESS",
                "error": t.error,
                "timestamp": t.timestamp,
                "tokens_in": t.input_tokens,
                "tokens_out": t.output_tokens,
                "cost": t.cost_usd,
            }
            for t in store_snapshot
        ]
    }

@app.get("/trace-analysis")
async def get_trace_analysis():
    """Return trace analysis, reading from file when available."""
    if ANALYSIS_FILE.exists():
        try:
            return json.loads(ANALYSIS_FILE.read_text())
        except json.JSONDecodeError:
            pass

    async with _trace_store_lock:
        store_snapshot = list(_trace_store)

    now = int(time.time())
    results = []
    for i, trace in enumerate(store_snapshot[:10]):
        results.append({
            "trace_index": i,
            "timestamp": now - (10 - i) * 60,
            "agent_count": random.randint(5, 50),
            "metrics": {
                "average_distance": round(random.uniform(5.0, 20.0), 2),
                "max_distance": round(random.uniform(20.0, 50.0), 2),
                "cluster_score": round(random.uniform(0.6, 0.99), 2),
            },
        })

    return {
        "analysis_timestamp": now,
        "trace_count": len(store_snapshot),
        "results": results,
    }

@app.get("/health")
async def health():
    async with _trace_store_lock:
        count = len(_trace_store)
    return {"status": "ok", "trace_count": count}

# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="127.0.0.1", port=8000, reload=True)
