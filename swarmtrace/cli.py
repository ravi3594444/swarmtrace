import sys

from swarmtrace.storage import get_by_id, get_traces

DEFAULT_VIEW_LIMIT = 100

VIEW_USAGE = """swarmtrace — show the traces recorded in the local DB.

Usage:
  swarmtrace [--limit N]

Options:
  --limit N   Show the N most recent traces (default: 100).
  -h, --help  Show this message and exit.
"""

REPLAY_USAGE = """swarmtrace-replay — show one recorded trace in full.

Usage:
  swarmtrace-replay <trace_id>

Run `swarmtrace` first to list trace IDs. With no arguments, the five most
recent traces are listed.
"""


class UsageError(ValueError):
    """Bad command-line input — the caller prints usage and exits non-zero."""


def parse_limit(args: list[str], default: int) -> int:
    """Parse ``--limit N`` / ``--limit=N`` out of *args*, rejecting anything else.

    Shared by `swarmtrace`, `swarmtrace-alerts list` and `swarmtrace-resync`,
    which each used to carry their own copy of this loop — and each silently
    fell back to the default on a non-integer value, so
    ``swarmtrace --limit twenty`` looked like it had honoured the flag while
    showing 100 rows.

    Unrecognized arguments are rejected too. Skipping them left exactly the
    same silent failure one typo over: ``swarmtrace --limti 5`` printed 100
    rows and exited 0, so the flag looked accepted. ``--limit`` is the only
    option these three commands take, so anything else is a mistake worth
    reporting rather than ignoring.
    """
    limit = default
    seen = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--limit":
            if i + 1 >= len(args):
                raise UsageError("--limit requires a value")
            raw = args[i + 1]
            i += 2
        elif arg.startswith("--limit="):
            raw = arg.split("=", 1)[1]
            i += 1
        else:
            raise UsageError(f"unknown argument: {arg}")
        try:
            limit = max(1, int(raw))
        except ValueError:
            raise UsageError(f"--limit expects an integer, got {raw!r}") from None
        seen = True
    return limit if seen else default


def _parse_limit(default: int = DEFAULT_VIEW_LIMIT) -> int:
    """Parse ``--limit`` from ``sys.argv`` (the `swarmtrace` view entry point)."""
    return parse_limit(sys.argv[1:], default)


# ---------- helpers ----------

def _wants_help(args: list[str]) -> bool:
    """Return True if *args* asks for help anywhere, not just in first position.

    Checked across the whole list because `swarmtrace-alerts list --help` puts
    the flag after the subcommand, and matching only ``args[0]`` made that
    print the alert table instead of the usage text.
    """
    return any(a in ("-h", "--help") for a in args)


def _tree_roots(traces):
    """Return visible tree roots and whether each is detached.

    A trace can reference a parent that is outside the current ``--limit``
    window (or was never recorded locally). Treating only ``parent_id=None``
    rows as roots made those otherwise-valid spans disappear from the tree.
    """
    trace_ids = {trace["id"] for trace in traces}
    return [
        (trace, trace["parent_id"] is not None)
        for trace in traces
        if trace["parent_id"] is None or trace["parent_id"] not in trace_ids
    ]


def _chronological(traces):
    """Order spans oldest-first for the tree view.

    ``get_traces()`` returns newest-first, which is what the table wants but
    the opposite of what a call tree wants: siblings rendered newest-first
    show the LAST tool an agent called at the top, so the tree reads
    backwards against the execution it is meant to depict. Sorting here (not
    in storage) keeps the table's newest-first ordering intact.

    Timestamps are ISO-8601 UTC strings, so lexicographic order is
    chronological order. Python's sort is stable, so spans sharing a
    timestamp keep their relative query order.
    """
    return sorted(traces, key=lambda t: t["timestamp"] or "")


def _print_tree(traces, parent_id=None, indent=0):
    ordered = _chronological(traces)
    if indent == 0 and parent_id is None:
        children = [trace for trace, _detached in _tree_roots(ordered)]
    else:
        children = [t for t in ordered if t["parent_id"] == parent_id]

    for t in children:
        # Rows are dicts keyed by column name (storage.py), so any future
        # migration column is automatically available under its own name here
        # with no code change needed — see storage.py:TraceRow.
        id_, func, error = t["id"], t["function"], t["error"]
        latency, in_tok, out_tok, cost, kind = (
            t["latency_sec"], t["input_tokens"], t["output_tokens"],
            t["cost_usd"], t["kind"],
        )
        status = "ERROR" if error else "OK"
        tag = "" if kind == "agent" else f" [{kind}]"
        detached = " [detached]" if indent == 0 and t["parent_id"] is not None else ""
        prefix = "    " * indent + ("└── " if indent > 0 else "")
        print(
            f"{prefix}{func}(){tag}{detached} [{id_}] {latency}s | "
            f"{in_tok}in/{out_tok}out | ${cost} | {status}"
        )
        _print_tree(traces, id_, indent + 1)


def _load_rich():
    """Return the rich classes the pretty renderers need, or ``None``.

    The import is probed in isolation, on its own, so that an ImportError
    raised from *inside* the rendering code cannot be mistaken for "rich
    isn't installed". Wrapping the whole render block in
    ``except ImportError`` used to silently downgrade the CLI to plain text
    whenever a rendering bug raised ImportError — the failure looked like a
    missing optional dependency and nothing surfaced it.
    """
    try:
        from rich.console import Console
        from rich.panel import Panel
        from rich.table import Table
        from rich.text import Text
        from rich.tree import Tree
    except ImportError:
        return None
    return {"Console": Console, "Panel": Panel, "Table": Table, "Text": Text, "Tree": Tree}


# ---------- view ----------

def _view_rich(rich, traces, total_cost, total_tokens) -> None:
    """Render the trace table + agent tree with rich."""
    console = rich["Console"]()
    Table, Text, Tree = rich["Table"], rich["Text"], rich["Tree"]

    table = Table(title="swarmtrace — Trace View", border_style="cyan")
    table.add_column("ID",       style="cyan",    width=10)
    table.add_column("Function", style="green",   width=20)
    table.add_column("Kind",     style="magenta", width=8)
    table.add_column("Latency",  style="yellow",  width=10)
    table.add_column("Tokens",   style="blue",    width=15)
    table.add_column("Cost",     style="magenta", width=12)
    table.add_column("Status",   width=8)

    for t in traces:
        id_, func, error, kind = t["id"], t["function"], t["error"], t["kind"]
        latency, in_tok, out_tok, cost = (
            t["latency_sec"], t["input_tokens"], t["output_tokens"], t["cost_usd"],
        )
        status     = "[red]ERROR[/red]" if error else "[green]OK[/green]"
        tokens_str = f"{in_tok or 0}in/{out_tok or 0}out"
        table.add_row(id_, func, kind, f"{latency}s", tokens_str, f"${cost or 0}", status)

    console.print(table)

    console.print("\n[bold cyan]=== Agent Tree ===[/bold cyan]")
    # Tree-view labels are wrapped in Text(no_wrap=True, overflow="ellipsis")
    # so rich truncates with "…" instead of word-wrapping onto a second
    # line (which broke indentation — see commit 2655ec9 for the original
    # wrap bug). Status is placed RIGHT AFTER the function name so it's
    # preserved even when the trailing trace ID gets truncated.
    #
    # Field order: func → status → kind-tag → latency → cost → id
    # (id last because it's the longest and least scannable; full ID
    # is still visible in the table view above and via `swarmtrace-replay`).
    def _tree_label(
        func: str,
        error,
        kind: str,
        latency,
        cost,
        tid: str,
        *,
        detached: bool = False,
    ):
        """Build one no-wrap tree row: func → status → kind → latency → cost → id."""
        status = "[red]✗[/red]" if error else "[green]✓[/green]"
        tag = "" if kind == "agent" else f" [dim]({kind})[/dim]"
        detached_tag = " [yellow](detached)[/yellow]" if detached else ""
        # Escape [ and ] around the trace ID with \[ \] so rich's markup
        # parser treats them as literal brackets, not style tags. Without
        # escaping, [root-1] is interpreted as a (nonexistent) style tag
        # and silently dropped from the output.
        label = (
            f"[blue]{func}()[/blue] {status}{tag}{detached_tag} "
            f"[yellow]{latency:.3f}s[/yellow] "
            f"[magenta]${cost or 0}[/magenta] \\[{tid}]"
        )
        text = Text.from_markup(label)
        text.no_wrap = True
        text.overflow = "ellipsis"
        return text

    # Oldest-first so the tree reads in execution order (see _chronological).
    ordered = _chronological(traces)

    def add_children(tree_node, pid):
        """Attach every child of *pid* under *tree_node*, recursing depth-first."""
        for child in [t for t in ordered if t["parent_id"] == pid]:
            cid, cfunc, cerror, ckind = (
                child["id"], child["function"], child["error"], child["kind"],
            )
            clatency, ccost = child["latency_sec"], child["cost_usd"]
            branch = tree_node.add(_tree_label(cfunc, cerror, ckind, clatency, ccost, cid))
            # CRITICAL: recurse into `branch` (the new child node),
            # NOT `tree_node` (the parent). Recursing into tree_node
            # flattens grandchildren into siblings — see commit
            # 2655ec9 for the regression that did exactly this.
            add_children(branch, cid)

    for root, detached in _tree_roots(ordered):
        id_, func, error, kind = root["id"], root["function"], root["error"], root["kind"]
        latency, cost = root["latency_sec"], root["cost_usd"]
        tree = Tree(
            _tree_label(func, error, kind, latency, cost, id_, detached=detached)
        )
        add_children(tree, id_)
        console.print(tree, soft_wrap=True)

    console.print(f"\n[bold]Total traces:[/bold] {len(traces)}")
    console.print(f"[bold]Total tokens:[/bold] {total_tokens}")
    console.print(f"[bold]Total cost:[/bold] [magenta]${round(total_cost, 6)}[/magenta]")


def _view_plain(traces, total_cost) -> None:
    """Render the trace table + agent tree without rich installed."""
    print("\n=== swarmtrace Trace View ===")
    for t in traces:
        id_, func, kind = t["id"], t["function"], t["kind"]
        latency, cost = t["latency_sec"], t["cost_usd"]
        status = "ERROR" if t["error"] else "OK"
        tag = "" if kind == "agent" else f" ({kind})"
        print(f"{id_:<10} {(func + tag):<20} {str(latency)+'s':<10} ${cost or 0} {status}")
    print("\n=== Agent Tree ===")
    _print_tree(traces)
    print(f"Total: {len(traces)} traces | ${round(total_cost, 6)}")


def view(limit=None):
    """Show recent traces. Usage: swarmtrace [--limit N] (default 100)."""
    if limit is None:
        if _wants_help(sys.argv[1:]):
            print(VIEW_USAGE, end="")
            return 0
        try:
            limit = _parse_limit()
        except UsageError as exc:
            print(f"swarmtrace: {exc}", file=sys.stderr)
            print(VIEW_USAGE, end="", file=sys.stderr)
            return 2
    try:
        traces = get_traces(limit=limit)
    except Exception:  # noqa: BLE001 -- CLI entry point, defensive outer boundary
        traces = []

    if not traces:
        print("No traces found. Run your agent with @observe first.")
        return 0

    total_cost   = sum(t["cost_usd"] for t in traces if t["cost_usd"])
    total_tokens = sum((t["input_tokens"] or 0) + (t["output_tokens"] or 0) for t in traces)

    rich = _load_rich()
    if rich is None:
        _view_plain(traces, total_cost)
    else:
        _view_rich(rich, traces, total_cost, total_tokens)
    return 0


# ---------- replay ----------

def replay(trace_id):
    trace = get_by_id(trace_id)

    if not trace:
        print(f"Trace {trace_id} not found.")
        return 1

    func, args, output = trace["function"], trace["args"], trace["output"]
    kind, latency, error = trace["kind"], trace["latency_sec"], trace["error"]
    timestamp, in_tok, out_tok = trace["timestamp"], trace["input_tokens"], trace["output_tokens"]
    cost, agent_id, agent_name, parent_id = (
        trace["cost_usd"], trace["agent_id"], trace["agent_name"], trace["parent_id"],
    )

    fields = [
        ("Function",  func),
        ("Kind",      kind),
        ("Agent",     f"{agent_name} ({agent_id})"),
        ("Timestamp", timestamp),
        ("Args",      args),
        ("Output",    output),
        ("Latency",   f"{latency}s"),
        ("Tokens",    f"{in_tok}in / {out_tok}out"),
        ("Cost",      f"${cost}"),
        ("Error",     error if error else "None"),
        ("Parent",    parent_id if parent_id else "root"),
    ]

    rich = _load_rich()
    if rich is None:
        print(f"\n=== swarmtrace replay: {trace_id} ===")
        for label, value in fields:
            print(f"{label:<10}: {value}")
        return 0

    console = rich["Console"]()
    # Pad the plain label (not the markup) so the colons line up — padding
    # the marked-up string counts the tag characters and skews the column.
    body = "\n".join(
        f"[cyan]{label + ':':<10}[/cyan] {value}" for label, value in fields
    )
    console.print(rich["Panel"](
        body,
        title=f"[bold]swarmtrace replay: {trace_id}[/bold]",
        border_style="cyan",
    ))
    return 0


def main_replay():
    args = sys.argv[1:]
    if _wants_help(args):
        print(REPLAY_USAGE, end="")
        return 0
    if not args:
        print(REPLAY_USAGE, end="")
        print("Recent traces:")
        for t in get_traces(limit=5):
            print(f"  {t['id']} — {t['function']}() — {t['timestamp']}")
        return 0
    return replay(args[0])


# ---------- alerts ----------

def _alerts_list(limit: int = 20) -> None:
    from swarmtrace.alerts import list_alerts
    rows = list_alerts(limit=limit)
    rich = _load_rich()
    if rich is None:
        if not rows:
            print("No alerts fired yet.")
            return
        for a in rows:
            print(
                f"{a['fired_at']}  [{a['severity']:8}] {a['rule']:22} "
                f"{a.get('agent_name') or '—':20} {a['message']}"
            )
        return

    console = rich["Console"]()
    if not rows:
        console.print("[yellow]No alerts fired yet.[/yellow]")
        return
    t = rich["Table"](title=f"swarmtrace — Last {len(rows)} alerts", border_style="cyan")
    t.add_column("Fired",     style="cyan",   width=22)
    t.add_column("Severity",  width=10)
    t.add_column("Rule",      style="green",  width=22)
    t.add_column("Agent",     style="magenta", width=20)
    t.add_column("Message",   width=80)
    t.add_column("Ack",       width=5)
    for a in rows:
        sev = a["severity"].upper()
        sev_styled = {
            "INFO":     "[blue]INFO[/blue]",
            "WARNING":  "[yellow]WARN[/yellow]",
            "CRITICAL": "[red]CRIT[/red]",
        }.get(sev, sev)
        acked = "[green]✓[/green]" if a.get("acked") else "·"
        t.add_row(
            a["fired_at"][:19], sev_styled, a["rule"],
            a.get("agent_name") or "—", a["message"], acked,
        )
    console.print(t)


def _alerts_test() -> None:
    """Run the rule engine once over the current traces and report any new alerts."""
    from swarmtrace.alerts import evaluate_now
    rich = _load_rich()
    console = rich["Console"]() if rich else None
    try:
        fired = evaluate_now()
    except Exception as exc:  # noqa: BLE001 -- CLI entry point: clean message + exit code, not a raw traceback
        print(f"[swarmtrace] alert evaluation failed: {exc}", file=sys.stderr)
        sys.exit(1)
    if not fired:
        msg = "No rules tripped. All clear. ✅"
        if console:
            console.print(f"[green]{msg}[/green]")
        else:
            print(msg)
        return
    for a in fired:
        line = f"[{a.severity.upper():8}] {a.rule:22} {a.agent_name or '':20} {a.message}"
        if console:
            console.print(line)
        else:
            print(line)
    print(f"\n{len(fired)} alert(s) fired.")


def _alerts_ack(alert_id: str) -> None:
    from swarmtrace.alerts import acknowledge
    if acknowledge(alert_id):
        print(f"✓ Acknowledged {alert_id}")
    else:
        print(f"Alert {alert_id} not found.")
        sys.exit(1)


def main_alerts():
    """
    swarmtrace alerts <subcommand> [...]

    Subcommands:
      list [--limit N]  Show recent alerts (default 20)
      test              Run the rule engine once over the current traces
      ack <alert_id>    Mark an alert as acknowledged
    """
    args = sys.argv[1:]
    # Check the whole argv, not just args[0]: `swarmtrace-alerts list --help`
    # used to fall through to the subcommand and print the alert table.
    if not args or _wants_help(args):
        print(main_alerts.__doc__)
        return
    sub = args[0]
    rest = args[1:]
    if sub == "list":
        try:
            limit = parse_limit(rest, 20)
        except UsageError as exc:
            print(f"swarmtrace-alerts: {exc}", file=sys.stderr)
            sys.exit(2)
        _alerts_list(limit=limit)
    elif sub == "test":
        _alerts_test()
    elif sub == "ack":
        if len(rest) < 1:
            print("Usage: swarmtrace-alerts ack <alert_id>", file=sys.stderr)
            sys.exit(2)
        _alerts_ack(rest[0])
    else:
        print(f"Unknown subcommand: {sub}", file=sys.stderr)
        print(main_alerts.__doc__, file=sys.stderr)
        sys.exit(2)


# ---------- resync ----------

def main_resync():
    """swarmtrace-resync — re-send traces that failed to reach the remote endpoint.

    Reads rows from the local SQLite DB where synced=0 (i.e. the background
    sender's 3 retries were exhausted, or the endpoint was unreachable when
    the trace was captured) and POSTs each one to /api/ingest again. On
    success, the row is marked synced=1.

    Use this after an endpoint outage, a network change, or any time the
    dashboard is missing traces you know were captured locally.

    Usage:
      swarmtrace-resync [--limit N]    # default: re-send up to 100 unsynced rows

    Exit code:
      0  all attempted rows sent successfully (or nothing to send)
      1  one or more rows still failed (re-run to retry)
    """
    from swarmtrace.runtime import resync as _resync

    args = sys.argv[1:]
    if _wants_help(args):
        print(main_resync.__doc__)
        return
    try:
        limit = parse_limit(args, 100)
    except UsageError as exc:
        print(f"swarmtrace-resync: {exc}", file=sys.stderr)
        sys.exit(2)

    attempted, succeeded, failed = _resync(batch_size=limit)

    if attempted == 0:
        print("No unsynced traces found. (Remote endpoint configured and "
              "up-to-date, or SWARMTRACE_API_KEY/SWARMTRACE_ENDPOINT not set.)")
        return

    print(f"Resync complete: {succeeded}/{attempted} traces sent successfully.")
    if failed:
        print(f"{failed} trace(s) still failed — re-run swarmtrace-resync to retry.")
        sys.exit(1)


if __name__ == "__main__":
    view()
