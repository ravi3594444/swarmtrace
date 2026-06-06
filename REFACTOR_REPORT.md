# SwarmTrace — Refactor & Audit Report

---

## 1. Bugs (actual errors that break the code)

### `swarm_agent.py` — Stray leading `o` character
**File:** `swarm_agent.py`, line 1  
The file starts with a bare `o` before the module docstring:
```python
o"""
Swarm Agent Implementation
```
This is a **SyntaxError** that prevents the module from importing at all.  
**Fix:** Remove the stray `o`.

---

### `tracely/budget.py` — Corrupted docstring (SyntaxError)
**File:** `tracely/budget.py`, line 37  
The docstring of `budget()` is broken:
```python
def budget(max_tokens: int = 10000, warn_at: float = 0.8, hard_stop: bool = False):
    ""ait why th          # ← broken — was probably `"""Wait, why th...`
    Token budget decorator …
```
The triple-quote is truncated, turning the rest of the docstring into a bare expression followed by a syntax error.  
**Fix:** Replace with a proper `"""..."""` docstring (done in refactored version).

---

### `tracely/budget.py` — `hard_stop` never fires on async path
The async wrapper calls `_track(...)` but doesn't re-raise the `RuntimeError` that `_track` raises when `hard_stop=True`.  The sync path works correctly because it also doesn't catch, but `_track` raises *inside* the wrapper and both paths need to let it propagate.  
**Fix:** `_track` now raises, both wrappers let it propagate naturally (no try/except around `_track`).

---

### `swarm_agent.py` — Agents walk off the world
`update_position` adds unbounded deltas to coordinates initialized in `[0, 100]`.  After enough iterations, agents drift to `±∞`.  
**Fix:** Clamp coordinates to `[0, WORLD_SIZE]` after each step.

---

### `tracely/tracer.py` — `kwargs` silently dropped from trace record
Both wrappers call `str(args[:2])` and ignore `**kwargs` entirely.  A call like `my_fn(system="…", user="…")` stores `"()"` — an empty args string — making replays useless.  
**Fix:** Append `kwargs.keys()` to the args repr when kwargs are non-empty.

---

## 2. Design / Quality Issues

### `api.py` — Global mutable `trace_data` + no lifespan
```python
trace_data = generate_trace_data()   # module-level mutable global

@app.get("/traces")
async def get_traces():
    global trace_data
    if random.random() < 0.3:
        trace_data = generate_trace_data(len(trace_data))
```
- Module-level mutation is not safe under hot-reload.
- FastAPI has a standard `lifespan` context manager for init/teardown.  
**Fix:** Move initialisation into `@asynccontextmanager async def lifespan(app)` and store state in a module-level variable that is only written from there.

---

### `api.py` — `allow_origins=["*"]` in production-adjacent code
`CORSMiddleware(allow_origins=["*"])` will be deployed verbatim.  
**Fix:** Restrict to known frontend origins; make it configurable via env var.

---

### `api.py` — `generate_trace_data` is one giant function with baked-in templates
500+ line function mixing template lookup, random-data generation, parent-tracking, and Trace construction.  
**Fix:** Extract `_FUNCTION_TEMPLATES` dict and `_make_trace()` helper; `generate_trace_data` becomes a simple loop.

---

### `swarm_metrics.py` — `generate_sample_metrics` creates a `MetricsCollector` internally and ignores `session_id` parameter
```python
def generate_sample_metrics(session_id: str, count: int = 10):
    collector = MetricsCollector()
    collector.start_session(session_id)
    ...
```
The caller has no access to the `collector`; they can never call `end_session` on it or `export_session`.  Also, every call creates a fresh collector so the "global metrics" list on each instance is wasted.  
**Recommendation:** Return `(collector, metrics)`, or make `generate_sample_metrics` a static helper on `MetricsCollector`.

---

### `swarm_module_0.py` … `swarm_module_4.py` — Five identical files
All five modules are identical (only the class/file number differs).  They also run simulation code at **import time** which pollutes `import` side-effects.  
**Fix:** Extract to a parameterised `SwarmTraceSimulator(index)` class in a single file; move the run loop under `if __name__ == "__main__"`.

---

### `tracely/storage.py` — Schema column defaults missing
```sql
CREATE TABLE IF NOT EXISTS traces (
    ...
    input_tokens  INTEGER,   -- ← no DEFAULT
    output_tokens INTEGER,
    cost_usd      REAL
)
```
Rows inserted without these columns (e.g. from older versions) will have `NULL`, causing silent arithmetic bugs (`None + 500 = TypeError` in Python).  
**Fix:** Add `DEFAULT 0` to all three numeric columns.

---

### `tracely/storage.py` — `_purge_old_rows` is called inside `save_trace` holding `_lock`
`COUNT(*)` on a 10 000-row table is fast, but it happens while holding the global write lock. Under high write throughput this can create lock contention.  
**Recommendation:** Keep the current approach (it's acceptable) but document the trade-off; alternatively use `WITHOUT ROWID` or a dedicated purge background thread if write throughput matters.

---

### `tracely/regression.py` — Hardcoded `claude-haiku-4-5-20251001` model string
The model ID will go stale.  
**Recommendation:** Make it a named constant or pull from env var `TRACELY_REGRESSION_MODEL`.

---

### `tracely/tool_attention.py` — Silent fallback hides missing dependencies
```python
except ImportError as e:
    self._index = None   # select() will silently return the first k tools
```
Callers get wrong results with no indication the index is missing.  
**Recommendation:** Raise the `ImportError` with an installation hint, or at minimum log a `warnings.warn`.

---

### `trace_analyzer.py` — Unused `import random`
`random` is imported at the top of `TraceAnalyzer` but only used in the standalone `generate_sample_traces()` function.  Not a bug but adds noise.

---

## 3. Code Style / Hygiene

| Location | Issue |
|---|---|
| `api.py` | `import random` at top but used only inside endpoint handlers — fine, just note it |
| `tracely/budget.py` | `import asyncio` at top, only used for `iscoroutinefunction` check |
| `tracely/cli.py` | `add_children` inner function is defined inside a loop — causes subtle closure bugs if ids overlap; extract it |
| `tracely/replay.py` | Duplicate of `cli.py:replay()` — the module exists twice; pick one location |
| All Python files | No `py.typed` marker; type checkers will ignore the package unless you add one |
| `setup.py` / `pyproject.toml` | `pyproject.toml` is nearly empty; migrate `setup.py` into `pyproject.toml` fully (PEP 517/518 standard) |

---

## 4. Frontend

### `use-api-live-traces.ts` — `DEMO_TRACES` shown on error
On any fetch failure the hook silently falls back to static demo data.  The UI shows real-looking (but fake) data with no indication there is a backend problem.  
**Recommendation:** Expose an `error` state from the hook so the UI can show a banner.

### `traces.functions.ts` — Hardcoded relative path `../../swarm_trace_analysis.json`
```ts
const filePath = path.join(process.cwd(), "../../swarm_trace_analysis.json");
```
This breaks if the frontend dev-server is started from any other directory.  
**Fix:** Move the path to an env var (`TRACE_ANALYSIS_FILE`) with a sensible default.

### `use-live-traces.ts` — Indirection with no purpose
```ts
export function useLiveTraces(enabled: boolean) {
  return useApiLiveTraces(enabled);
}
```
This thin re-export adds a layer of indirection. It's fine if you plan to swap implementations, but if not it's dead weight.

---

## 5. Summary table

| Severity | Count | Examples |
|---|---|---|
| 🔴 Bug / SyntaxError | 2 | `swarm_agent.py` stray `o`; `budget.py` broken docstring |
| 🟠 Logic error | 2 | Agents escape world bounds; `kwargs` dropped from traces |
| 🟡 Design issue | 6 | Global mutation in API; duplicate modules; missing SQL defaults; unused `MetricsCollector` in helper |
| 🔵 Style / hygiene | 5 | Duplicate `replay`; empty `pyproject.toml`; hardcoded model ID; etc. |

Refactored versions of `api.py`, `swarm_agent.py`, `tracely/storage.py`, `tracely/tracer.py`, and `tracely/budget.py` are included as separate files.
