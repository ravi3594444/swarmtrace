# Changelog

All notable changes to **swarmtrace** are documented here. Versions match
PyPI releases. Format is loosely [Keep a Changelog](https://keepachangelog.com/),
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Lambda disambiguation for stable `agent_id`** (`swarmtrace/tracer.py`):
  two distinct `@observe` lambdas in the same scope used to silently
  collapse into one dashboard agent card because all lambdas share the
  `__qualname__` `<lambda>` (or `outer.<locals>.<lambda>`). The
  `_stable_agent_id` derivation now appends `co_firstlineno` to the hash
  source when `<lambda>` appears in the qualname. Line number is stable
  across calls of the same lambda (so repeat runs still aggregate) but
  differs between distinct lambdas (so they don't collide). Named
  functions are unaffected — refactoring (moving a function to a
  different line) must not break aggregation. Closures from the same
  factory still share a source line by definition, so they keep the
  documented limitation (use `name=` to disambiguate).

## [0.4.9] — 2026-07-05

### Fixed
- **Stable `agent_id` for bare `@observe`** (`swarmtrace/tracer.py`): repeated
  invocations of the same top-level `@observe` function used to get a fresh
  random `agent_id` per call (equal to that call's `trace_id`). Combined with
  the dashboard grouping strictly by `agent_id`, every run of the same agent
  showed up as a *new* agent card with `tasks: 1`, instead of one persistent
  agent whose task count climbed over time. Now `agent_id` is derived from a
  SHA-256 of `"{module}.{qualname}"`, so repeat runs collapse into one identity.
- **Matching `/api/agents` filter** (`frontend-next/app/api/agents/route.ts`):
  dropped the `t.id === agent_id` check from the group filter. That check was
  an artifact of the old `agent_id = trace_id` invariant and would have
  silently dropped every bare-`@observe` agent under the stable-id scheme
  (zero agent cards on the dashboard). The `kind === 'agent'` check alone is
  sufficient — orphan tool/llm/function spans still don't become phantom
  agents because their `kind !== 'agent'`.
- **SDK ↔ API contract test** (`tests/test_tracer.py::test_api_agents_filter_contract`):
  reproduces the exact `/api/agents` filter logic against real tracer output.
  Covers all four `agent_id` regimes (bare `@observe` aggregation, explicit
  swarm sub-agents, nested non-agent rollup, orphan phantom prevention). Any
  future change to EITHER the SDK's `agent_id` assignment OR the API filter
  that breaks the contract fails here instead of silently breaking the
  dashboard.

### Added
- **`observe(name=...)` parameter**: optional string that overrides the
  displayed `agent_name` AND seeds the stable `agent_id` hash instead of
  `func.__qualname__`. Useful when the same function represents different
  agents based on runtime config, or when you want a human-readable id source.
  Ignored for the `agent_id` of explicit `kind="agent"` (those keep fresh
  per-call ids), but still overrides `agent_name` for readability.

### Changed
- Existing tests in `test_tracer.py` and `test_auto_instrument.py` updated to
  read `agent_id` from position `-2` (the field) instead of `0` (the row id)
  since they're no longer equal for bare `@observe`. Semantics each test
  encodes are unchanged.

### Known limitations
- Historical traces in users' DBs retain old random `agent_id`s and will
  appear as orphan agent cards until they age out of the 500-row window.
  New runs get the stable hash and aggregate correctly. One-time migration
  pain, not permanent.
- ~~Two `@observe` lambdas in the same scope share `__qualname__` (`<lambda>`)
  and would collapse into one agent. Workaround: use `@observe(name='a')`.~~
  **Resolved in [Unreleased]** — line-number disambiguation added.
- Closures created from the same factory function share `__qualname__` and
  would collapse. Workaround: same — use `name=`.

## [0.4.8] — 2026-07-05 (preceding 0.4.9 by hours)

### Added
- `patch_all()` / `init()` self-reports which LLM SDKs are active.
- FOV opt-in documentation + MCP quickstart in README.
- `fov` extra declared in `pyproject.toml` (was implicit before).

## [0.4.7] — 2026

### Fixed
- FOV: stop screenshot spam after browser closes.

## [0.4.6] — 2026

### Fixed
- Endpoint URL 404 (inconsistency between `tracer.py` and `fov.py`).

## [0.4.5] — 2026

### Fixed
- Lazy-import `numpy` so `import swarmtrace` works without `numpy` installed
  (only needed for the optional `tools` extra).

## [0.4.4] — 2026

### Changed
- Replaced rate-limited screenshots with a background screen streamer for FOV.

## [0.4.3] — 2026

### Fixed
- 24/7 production hardening (various stability fixes for long-running agents).

## [0.4.2] — 2026

Maintenance version bump.

## [0.4.1] — 2026

### Changed
- Renamed all `tracely` references to `swarmtrace`.

## [0.4.0] — 2026

Maintenance version bump.

## [0.3.1] — 2026

### Added
- FOV: live agent activity feed.

## [0.3.0] — 2026

### Added
- Span taxonomy: every traced call now has a `kind`
  (`'agent' | 'tool' | 'llm' | 'function'`) and is attributed (via
  `agent_id` / `agent_name`) to the nearest enclosing `kind='agent'` span.
  This is the foundation for the dashboard's Agents page.

## [0.2.0] — 2026

### Added
- Budget monitoring, tool attention, web scraper, replay, `show_failures`.

## [0.1.x] — 2026

Initial releases. Core `@observe` decorator, SQLite storage, CLI, remote
ingest, pricing calculation, regression analysis.
