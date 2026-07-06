"""Manual stress-test script for the local API's read path (GET /traces).

Not collected by pytest — run directly: python tests/stress_api.py
"""

import statistics
import threading
import time

import requests

API_URL = "http://localhost:8000/traces"


def simulate_reads(num_requests):
    latencies = []
    successes = 0
    for _ in range(num_requests):
        try:
            start = time.perf_counter()
            resp = requests.get(API_URL, timeout=5)
            latencies.append(time.perf_counter() - start)
            if resp.status_code == 200:
                successes += 1
        except Exception:
            pass
    return latencies, successes


def run_stress_test(concurrent_users=10, requests_per_user=50):
    results = [None] * concurrent_users

    print(f"Starting stress test with {concurrent_users} users, {requests_per_user} requests each...")

    def worker(idx):
        results[idx] = simulate_reads(requests_per_user)

    start_time = time.time()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(concurrent_users)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    end_time = time.time()

    all_latencies = [lat for r in results if r for lat in r[0]]
    total_successes = sum(r[1] for r in results if r)

    if not all_latencies:
        print("No requests completed successfully.")
        return

    avg_latency = statistics.mean(all_latencies) * 1000
    p95_latency = (
        statistics.quantiles(all_latencies, n=20)[18] * 1000
        if len(all_latencies) >= 2
        else all_latencies[0] * 1000
    )

    print("--- Stress Test Results ---")
    print(f"Total Requests: {len(all_latencies)}")
    print(f"Successful (200): {total_successes}")
    print(f"Total Time: {end_time - start_time:.2f}s")
    print(f"Average Latency: {avg_latency:.2f}ms")
    print(f"P95 Latency: {p95_latency:.2f}ms")
    print(f"Throughput: {len(all_latencies) / (end_time - start_time):.2f} req/s")


if __name__ == "__main__":
    run_stress_test()
