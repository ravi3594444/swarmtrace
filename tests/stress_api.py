import time
import requests
import threading
import uuid
import statistics

# Assume the local API is running on port 8000
API_URL = "http://localhost:8000/traces"

def simulate_ingest(num_requests):
    latencies = []
    successes = 0
    for i in range(num_requests):
        try:
            start = time.perf_counter()
            resp = requests.get(API_URL, timeout=5)
            if resp.status_code == 200:
                successes += 1
            latencies.append(time.perf_counter() - start)
        except Exception:
            pass
    return latencies, successes

def run_stress_test(concurrent_users=10, requests_per_user=50):
    threads = []
    all_latencies = []

    print(f"Starting stress test with {concurrent_users} users, {requests_per_user} requests each...")

    start_time = time.time()
    for _ in range(concurrent_users):
        t = threading.Thread(target=lambda: all_latencies.extend(simulate_ingest(requests_per_user)[0]))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()
    end_time = time.time()

    if not all_latencies:
        print("No requests completed successfully.")
        return

    avg_latency = statistics.mean(all_latencies) * 1000
    p95_latency = statistics.quantiles(all_latencies, n=20)[18] * 1000

    print(f"--- Stress Test Results ---")
    print(f"Total Requests: {len(all_latencies)}")
    print(f"Total Time: {end_time - start_time:.2f}s")
    print(f"Average Latency: {avg_latency:.2f}ms")
    print(f"P95 Latency: {p95_latency:.2f}ms")
    print(f"Throughput: {len(all_latencies) / (end_time - start_time):.2f} req/s")

if __name__ == "__main__":
    run_stress_test()
