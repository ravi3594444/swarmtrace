"""
FastAPI backend for SwarmTrace application.
Provides API endpoints for the frontend to consume trace data.
"""

import json
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

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ANALYSIS_FILE = Path("swarm_trace_analysis.json")

ALLOWED_ORIGINS: List[str] = [
    "http://localhost:5173",
    "http://localhost:3000",
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
# Trace generation
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
    """Generate realistic trace data with parent–child hierarchy."""
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

@app.get("/traces", response_model=List[Trace])
async def get_traces():
    """Return all swarm traces, occasionally refreshing the dataset."""
    global _trace_store
    if random.random() < 0.3:
        _trace_store = generate_trace_data(len(_trace_store))
    return _trace_store


@app.get("/trace-analysis")
async def get_trace_analysis():
    """Return trace analysis, reading from file when available."""
    if ANALYSIS_FILE.exists():
        try:
            return json.loads(ANALYSIS_FILE.read_text())
        except json.JSONDecodeError:
            # Fall through to generated data
            pass

    now = int(time.time())
    results = []
    for i, trace in enumerate(_trace_store[:10]):
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
        "trace_count": len(_trace_store),
        "results": results,
    }


@app.get("/health")
async def health():
    return {"status": "ok", "trace_count": len(_trace_store)}


# ---------------------------------------------------------------------------
# New Dashboard Endpoints (Overview, Agents, Metrics, Settings)
# ---------------------------------------------------------------------------

# In-memory API keys store (for hackathon demo)
_api_keys: dict = {}


@app.get("/overview")
async def get_overview():
    """Aggregated system overview for the Overview page."""
    return {
        "system_health": 99.9,
        "active_agents": len(_trace_store),
        "total_throughput": sum(t.input_tokens + t.output_tokens for t in _trace_store),
        "avg_latency_ms": round(
            sum(t.latency_sec for t in _trace_store) / max(len(_trace_store), 1) * 1000,
            1,
        ),
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
            for t in _trace_store[:3]
        ],
        "events": [
            {
                "time": t.timestamp[-8:-3],
                "level": "ERROR" if t.error else "INFO",
                "message": t.error or f"{t.function} completed in {t.latency_sec}s",
            }
            for t in _trace_store[:5]
        ],
    }


@app.get("/agents")
async def get_agents():
    """Aggregated agent status for the Agents page."""
    seen = {}
    for t in _trace_store:
        if t.function not in seen:
            seen[t.function] = {
                "name": t.function,
                "model": "claude-haiku",
                "status": "Error" if t.error else "Running",
                "current_task": t.args[:40],
                "token_usage_1hr": t.input_tokens + t.output_tokens,
                "uptime": f"{random.randint(1, 30)}d {random.randint(0, 23)}h",
                "success_rate": round(random.uniform(95, 99.9), 1),
            }
    return list(seen.values())


@app.get("/metrics")
async def get_metrics():
    """Aggregated metrics for the Metrics page."""
    total_cost = sum(t.cost_usd for t in _trace_store)
    total_in = sum(t.input_tokens for t in _trace_store)
    total_out = sum(t.output_tokens for t in _trace_store)
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
                "agent": t.function,
                "hour": i,
                "latency_ms": round(t.latency_sec * 1000 * random.uniform(0.5, 1.5)),
            }
            for t in _trace_store[:3]
            for i in range(0, 24, 2)
        ],
    }


# --- Settings: API Keys ---

@app.get("/settings/api-keys")
async def list_api_keys():
    return [
        {
            "id": k,
            "name": v["name"],
            "created": v["created"],
            "last_used": v["last_used"],
            "prefix": k[:8] + "...",
        }
        for k, v in _api_keys.items()
    ]


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
    return {
        "plan": "Pro",
        "traces_used": len(_trace_store),
        "traces_limit": 100_000,
        "cost_this_month": round(sum(t.cost_usd for t in _trace_store), 4),
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
    return [
        {
            "name": "tracely @observe",
            "status": "connected",
            "description": "Auto-traces all decorated functions",
        },
        {
            "name": "Token Budget",
            "status": "connected",
            "description": "Monitors token limits per agent",
        },
        {
            "name": "Tool Attention",
            "status": "disconnected",
            "description": "Requires sentence-transformers + faiss",
        },
        {
            "name": "Scrapling",
            "status": "disconnected",
            "description": "Web scraping traces",
        },
        {
            "name": "Regression Detector",
            "status": "disconnected",
            "description": "Requires LIGHTNING_API_KEY",
        },
    ]


# ---------------------------------------------------------------------------
# Dev entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
