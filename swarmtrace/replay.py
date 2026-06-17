from swarmtrace.storage import get_traces

# replay() lives in swarmtrace.cli — import from there to avoid duplication.
from swarmtrace.cli import replay  # noqa: F401  (re-exported for backwards compat)


def show_failures():
    traces = get_traces(limit=50)
    failed = [t for t in traces if t[6]]

    if not failed:
        print("No failures found.")
        return

    print("\n=== Failed Traces ===")
    print(f"{'ID':<10} {'FUNCTION':<20} {'ERROR':<40} {'TIMESTAMP'}")
    print("-" * 90)
    for t in failed:
        id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost, kind, agent_id, agent_name = t
        print(f"{id_:<10} {func:<20} {str(error)[:38]:<40} {timestamp}")
    print(f"\nTotal failures: {len(failed)}")
    print("\nReplay any failure: from swarmtrace.replay import replay; replay('id')")
