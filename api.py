"""
FastAPI backend for SwarmTrace application.
Provides API endpoints for the frontend to consume trace data.
"""

import asyncio
import json
import os
import random
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from tracely.storage import get_all_traces as _db_get_all_traces

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANALYSIS_FILE = Path("swarm_trace_analysis.json")

# Comma-separated list of allowed origins.
# Set ALLOWED_ORIGINS env var for cloud deployments (Lightning AI, Codespaces, etc.)
# Example: ALLOWED_ORIGINS="https://myapp.lightning.ai,https://abc123.github.dev"
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
# Trace generation (demo fallback only)
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
    trace_id = uuid.uuid4().hex[:8]

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

app = FastAPI(title="SwarmTrace API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/ingest", status_code=204)
async def ingest_trace(trace: Trace):
    """
    Ingest a new trace from the @observe decorator.
    Saves to the local SQLite DB.
    """
    from tracely.storage import save_trace as _db_save_trace

    _db_save_trace(
        trace.id,
        trace.parent_id,
        trace.function,
        trace.args,
        trace.output,
        trace.latency_sec,
        trace.error,
        trace.timestamp,
        trace.input_tokens,
        trace.output_tokens,
        trace.cost_usd,
    )
    return


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
# Dashboard Endpoints (Overview, Agents, Metrics, Settings)
# ---------------------------------------------------------------------------

# In-memory API keys store (for hackathon demo)
_api_keys: dict = {}

@app.get("/overview")
async def get_overview():
    """Aggregated system overview for the Overview page."""
    async with _trace_store_lock:
        store_snapshot = list(_trace_store)

    active_agents = len(store_snapshot)
    total_throughput = sum(t.input_tokens + t.output_tokens for t in store_snapshot)
    avg_latency_ms = round(
        sum(t.latency_sec for t in store_snapshot) / max(len(store_snapshot), 1) * 1000,
        1,
    )

    return {
        "system_health": 99.9,
        "active_agents": active_agents,
        "total_throughput": total_throughput,
        "avg_latency_ms": avg_latency_ms,
        "activity": [
            {"time": f"{i:02d}:00", "value": random.randint(1000, 8000)}
            for i in range(0, 24, 2)
        ],
        "top_agents": [
            {
                "name": t.function,
                "id": t.id,
                "score": round(random.uniform(90, 99), 1),
                "status": "ACTIVE" if not t.error else "ERROR",
            }
            for t in store_snapshot[:3]
        ],
        "events": [
            {
                "timestamp": t.timestamp,
                "type": "ERROR" if t.error else "INFO",
                "message": t.error or f"{t.function} completed in {t.latency_sec}s",
            }
            for t in store_snapshot[:5]
        ],
    }

@app.get("/agents")
async def get_agents():
    """Aggregated agent status for the Agents page."""
    async with _trace_store_lock:
        store_snapshot = list(_trace_store)

    seen = {}
    for t in store_snapshot:
        if t.function not in seen:
            seen[t.function] = {
                "id": t.id,
                "name": t.function,
                "status": "RUNNING" if not t.error else "ERROR",
                "tasks": random.randint(1, 20),
                "tokens": f"{(t.input_tokens + t.output_tokens) // 1000}K",
                "lastActive": "just now",
                "uptime": f"{random.randint(1, 30)}d {random.randint(0, 23)}h",
                "success_rate": f"{round(random.uniform(95, 99.9), 1)}%",
                "current_task": t.args[:50] if t.args else "Idle",
            }
    return {"agents": list(seen.values())}

@app.get("/metrics")
async def get_metrics():
    """Aggregated metrics for the Metrics page."""
    async with _trace_store_lock:
        store_snapshot = list(_trace_store)

    total_cost = sum(t.cost_usd for t in store_snapshot)
    total_in = sum(t.input_tokens for t in store_snapshot)
    total_out = sum(t.output_tokens for t in store_snapshot)
    return {
        "daily_burn_rate": round(total_cost * 24, 2),
        "projected_monthly": round(total_cost * 24 * 30, 2),
        "budget": 5000,
        "spent": round(total_cost * 24 * 15, 2),
        "token_volume": {
            "input": total_in,
            "output": total_out,
            "chart": [
                {
                    "day": i + 1,
                    "input": random.randint(1_000_000, 8_000_000),
                    "output": random.randint(500_000, 4_000_000),
                }
                for i in range(30)
            ],
        },
        "latency_heatmap": [
            {
                "time": f"{i}:00",
                "Retrieval_v2": round(t.latency_sec * 1000 * random.uniform(0.6, 1.2)),
                "Synthesis_v1": round(t.latency_sec * 1000 * random.uniform(0.5, 1.0)),
                "Router_fast": round(t.latency_sec * 1000 * random.uniform(0.3, 0.8)),
            }
            for t in store_snapshot[:3]
            for i in range(0, 24, 4)
        ],
    }

# --- Settings: API Keys ---

@app.get("/settings/api-keys")
async def list_api_keys():
    return {
        "keys": [
            {
                "id": k,
                "name": v["name"],
                "created": v["created"],
                "last_used": v["last_used"],
                "prefix": k[:8] + "...",
            }
            for k, v in _api_keys.items()
        ]
    }

@app.post("/settings/api-keys")
async def create_api_key(body: dict):
    key = "st_" + secrets.token_hex(24)
    _api_keys[key] = {
        "name": body.get("name", "New Key"),
        "created": datetime.now(timezone.utc).isoformat(),
        "last_used": None,
    }
    return {"key": key}

@app.delete("/settings/api-keys/{key_id}")
async def revoke_api_key(key_id: str):
    _api_keys.pop(key_id, None)
    return {"status": "revoked"}

# --- Settings: Billing ---

@app.get("/settings/billing")
async def get_billing():
    async with _trace_store_lock:
        count = len(_trace_store)
        cost = sum(t.cost_usd for t in _trace_store)
    return {
        "plan": "Pro",
        "traces_used": count,
        "traces_limit": 100_000,
        "cost_this_month": round(cost, 4),
        "next_billing": "2026-07-01",
    }

# --- Settings: Team ---

@app.get("/settings/team")
async def get_team():
    return [
        {
            "name": "Ravi Kumar",
            "email": "ravi@swarmtrace.io",
            "role": "Admin",
            "joined": "2026-01-01",
        }
    ]

# --- Settings: Integrations ---

@app.get("/settings/integrations")
async def get_integrations():
    return {
        "integrations": [
            {
                "id": "tracely-observe",
                "name": "tracely @observe",
                "connected": True,
                "description": "Auto-traces all decorated functions",
            },
            {
                "id": "token-budget",
                "name": "Token Budget",
                "connected": True,
                "description": "Monitors token limits per agent",
            },
            {
                "id": "tool-attention",
                "name": "Tool Attention",
                "connected": False,
                "description": "Requires sentence-transformers + faiss",
            },
            {
                "id": "scrapling",
                "name": "Scrapling",
                "connected": False,
                "description": "Web scraping traces",
            },
            {
                "id": "regression-detector",
                "name": "Regression Detector",
                "connected": False,
                "description": "Requires LIGHTNING_API_KEY",
            },
        ]
    }

# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)