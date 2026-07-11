# Changelog

All notable changes to **swarmtrace** are documented here. Versions match
PyPI releases. Format is loosely [Keep a Changelog](https://keepachangelog.com/),
adheres to [Semantic Versioning](https://semver.org/).

## [0.6.2] — 2026-07-12

### Fixed
- **`swarmtrace` CLI no longer crashes with `ValueError: too many values to
  unpack (expected 14)`** (`swarmtrace/cli.py`): `view()` and `replay()`
  unpacked exactly 14 fields from each trace row, but the `traces` table
  actually has 16 columns after the `session_id` and `synced` migrations
  (`storage.py:_ADDED_COLUMNS`). `SELECT *` returned 16 values, the tuple
  unpack raised, and the `swarmtrace` CLI crashed on every invocation after
  any trace was recorded — meaning every new user who ran `pip install
  swarmtrace`, decorated a function, and then ran `swarmtrace` to view their
  traces hit an immediate crash. Reproduced live by running the dogfood RAG
  agent against `mistral-large-latest` and then running `swarmtrace` to view
  the trace. Fix: append `*_` to every unpack in `cli.py` (6 sites) so
  trailing columns are swallowed. Future migration columns won't rebreak
  this.

- **Tree view no longer wraps branch labels onto a second line at 80 cols**
  (`swarmtrace/cli.py`): the tree view rendered every branch with a trailing
  `OK` / `ERROR` suffix, duplicating the Status column already shown in the
  table view above. The extra suffix pushed branch labels like
  `mistral_answer() (llm) [32-char-uuid] 0.608s $0.000236 OK` past 80 cols,
  and `rich.Tree` wrapped the trailing `OK` onto a second line, breaking the
  indentation:
  ```
  ├── mistral_answer() (llm) [41c2494b...] 0.608s $0.000236
  │   OK                                                          ← BROKEN
  ```
  Fix: drop the status suffix from the tree view (errors are still visible
  in the table view; users who want full detail use `swarmtrace-replay
  <id>`). Also pass `soft_wrap=True` to `console.print(tree)` so any future
  length growth truncates cleanly instead of wrapping. **Full 32-char trace
  IDs are preserved** — `swarmtrace-replay <id>` does an exact `get_by_id()`
  lookup and needs the full UUID. An earlier attempt truncated IDs to 8
  chars for aesthetics; reverted after realizing this breaks the replay
  workflow.

### Added
- **`tests/test_cli.py`** — first ever coverage for `view()` and `replay()`.
  The bug shipped because neither function had a test. Seven cases:
  full-schema unpack, empty DB, error rows, replay full-schema, replay
  missing trace, full 32-char trace ID preservation, tree-view no-wrap at
  80 cols. All exercise the real storage layer against a temp DB (no mocks).
  196 tests now pass (was 189).

## [0.6.1] — 2026-07-11

### Added
- **Project URLs in `pyproject.toml`** (`[project.urls]` section): Homepage,
  Repository, Changelog, Issues, Documentation. PyPI now links to the website
  (https://swarmtrace.vercel.app) and GitHub repo from the package page. This
  gives Google an authoritative inbound link to the site from pypi.org (one of
  the most highly-indexed domains), which helps with search discovery
  independently of sitemap submission. No code changes — metadata-only release.

## [0.6.0] — 2026-07-11

### Fixed
- **`args_repr` now capped at 4000 chars to match `output`** (`swarmtrace/tracer.py`):
  `_flush` was doing `args_repr = str(args[:2])` (no cap) while `output` went
  through `_safe_str(result)` (capped at 4000). A function called with one
  large argument (big string, dataframe repr, base64 screenshot, etc.) produced
  a trace whose `args` field was unbounded while `output` was exactly 4000 chars.
  Downstream: the oversized row could push its batch over the server's
  `MAX_BODY_BYTES = 64KB` → 413 → `resync()` retries the row forever (it never
  fits), never marks it `synced=1`, and it silently leaks in the local SQLite
  DB forever while burning retry time on every resync run. Confirmed live with
  non-compressible base64 args (the real-world case — repetitive `XXXX...`
  gzips 250:1 and hid the bug). Fix: `args_repr = _safe_str(args[:2])` so both
  fields cap at 4000. After fix, the previously-oversized batch gzips to ~3.4KB
  and syncs cleanly. Audit finding #3.

### Changed
- **`SWARMTRACE_ENDPOINT` now requires `https://` (or localhost)** (`swarmtrace/tracer.py`):
  `_normalize_base_url` previously accepted any string, so
  `SWARMTRACE_ENDPOINT=http://example.com` would silently send the API key
  over plaintext HTTP with zero warning. New `_validate_endpoint_scheme(url)`
  function rejects non-https URLs unless the host is `localhost`, `127.0.0.1`,
  or `::1`. When rejected, `_remote_config` logs a warning AND returns an empty
  URL — the worker skips sending (matching the "no endpoint configured" path)
  so the API key never goes over the wire. **⚠️ Breaking change for SDK users
  with `SWARMTRACE_ENDPOINT=http://non-localhost`:** the SDK will refuse to
  send traces after upgrading. Switch to `https://`, or use
  `http://localhost:...` for local dev. RFC1918 IPs (`192.168.x.x`, `10.x.x.x`)
  are intentionally NOT excepted — they're often used for internal services
  that may not be as trusted as a dev loopback. Users who need them can set up
  HTTPS locally (mkcert, caddy). Audit finding #5.

### Notes
- This version also includes frontend-side audit fixes (key-cache revocation
  redesign, `truncated` indicator in dashboard UI) that ship with the Next.js
  deployment, not the PyPI package. See PR #16 for the full breakdown.

## [0.4.10] — 2026-07-07

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
  **Resolved in [0.4.10]** — line-number disambiguation added.
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
