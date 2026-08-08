import asyncio
import statistics
import time

from swarmtrace.tracer import init, observe

# Disable remote ingest and auto-instrumentation so only the decorator's
# own overhead is measured.
init(api_key="", endpoint="", auto_instrument=False)

def sync_work():
    return sum(range(1000))

@observe
def sync_work_observed():
    return sum(range(1000))

async def async_work():
    await asyncio.sleep(0.001)
    return sum(range(1000))

@observe
async def async_work_observed():
    await asyncio.sleep(0.001)
    return sum(range(1000))

def benchmark_sync(iterations=1000):
    # Warmup
    for _ in range(100):
        sync_work()
        sync_work_observed()

    latencies_raw = []
    for _ in range(iterations):
        start = time.perf_counter()
        sync_work()
        latencies_raw.append(time.perf_counter() - start)

    latencies_observed = []
    for _ in range(iterations):
        start = time.perf_counter()
        sync_work_observed()
        latencies_observed.append(time.perf_counter() - start)

    return latencies_raw, latencies_observed

async def benchmark_async(iterations=1000):
    # Warmup
    for _ in range(100):
        await async_work()
        await async_work_observed()

    latencies_raw = []
    for _ in range(iterations):
        start = time.perf_counter()
        await async_work()
        latencies_raw.append(time.perf_counter() - start)

    latencies_observed = []
    for _ in range(iterations):
        start = time.perf_counter()
        await async_work_observed()
        latencies_observed.append(time.perf_counter() - start)

    return latencies_raw, latencies_observed

def print_stats(name, raw, observed):
    avg_raw = statistics.mean(raw) * 1000
    avg_obs = statistics.mean(observed) * 1000
    med_raw = statistics.median(raw) * 1000
    med_obs = statistics.median(observed) * 1000
    print(f"--- {name} ---")
    print(f"Average Raw: {avg_raw:.4f} ms | Median: {med_raw:.4f} ms")
    print(f"Average Observed: {avg_obs:.4f} ms | Median: {med_obs:.4f} ms")
    print(f"Overhead (mean): {avg_obs - avg_raw:.4f} ms")
    print(f"Overhead (median): {med_obs - med_raw:.4f} ms")
    print(f"Max Observed: {max(observed)*1000:.4f} ms")
    print()

if __name__ == "__main__":
    print("Running benchmarks...\n")

    raw_s, obs_s = benchmark_sync()
    print_stats("Sync Benchmarks", raw_s, obs_s)

    raw_a, obs_a = asyncio.run(benchmark_async())
    print_stats("Async Benchmarks", raw_a, obs_a)
