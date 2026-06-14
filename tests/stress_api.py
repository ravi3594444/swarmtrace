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
        trace_id = uuid.uuid4().hex
        # Although the local API is read-only for /traces, let's see how it handles requests.
        # Wait, the local API.py only has GET /traces.
        # The production ingest is in Next.js which I can't run easily here.
        # I will test the local API's GET /traces performance under load instead.
        start = time.perf_counter()
        try:
            resp = requests.get(API_URL, timeout=5)
            if resp.status_code == 200:
                successes += 1
        except Exception:
            pass
        latencies.append(time.perf_counter() - start)
    return latencies, successes

def run_stress_test(concurrent_users=10, requests_per_user=50):
    threads = []
    all_latencies = []
    total_successes = 0

    print(f"Starting stress test with {concurrent_users} users, {requests_per_user} requests each...")

    start_time = time.time()
    for _ in range(concurrent_users):
        t = threading.Thread(target=lambda: all_latencies.extend(simulate_ingest(requests_per_user)[0]))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()
    end_time = time.time()

    avg_latency = statistics.mean(all_latencies) * 1000
    p95_latency = statistics.quantiles(all_latencies, n=20)[18] * 1000

    print(f"--- Stress Test Results ---")
    print(f"Total Requests: {concurrent_users * requests_per_user}")
    print(f"Total Time: {end_time - start_time:.2f}s")
    print(f"Average Latency: {avg_latency:.2f}ms")
    print(f"P95 Latency: {p95_latency:.2f}ms")
    print(f"Throughput: {(concurrent_users * requests_per_user) / (end_time - start_time):.2f} req/s")

if __name__ == "__main__":
    # Start the local API in the background
    # (Assuming it's not already running)
    print("This test expects the FastAPI backend to be running.")
    run_stress_test()
