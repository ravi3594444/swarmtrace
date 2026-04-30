import sys
sys.path.insert(0, "/teamspace/studios/this_studio/tracely")

from tracely.storage import get_by_id, get_traces

def replay(trace_id: str):
    trace = get_by_id(trace_id)
    if not trace:
        print(f"Trace {trace_id} not found.")
        return

    id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = trace

    print("\n=== Tracely Replay: " + trace_id + " ===")
    print("Function  : " + str(func))
    print("Timestamp : " + str(timestamp))
    print("Args      : " + str(args))
    print("Output    : " + str(output))
    print("Latency   : " + str(latency) + "s")
    print("Tokens    : " + str(in_tok) + " in / " + str(out_tok) + " out")
    print("Cost      : $" + str(cost))
    print("Error     : " + str(error if error else "None"))
    print("Parent    : " + str(parent_id if parent_id else "root"))

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
        id_, parent_id, func, args, output, latency, error, timestamp, in_tok, out_tok, cost = t
        print(f"{id_:<10} {func:<20} {str(error)[:38]:<40} {timestamp}")
    print(f"\nTotal failures: {len(failed)}")
    print("\nReplay any failure: from tracely.replay import replay; replay('id')")
