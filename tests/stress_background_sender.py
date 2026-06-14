import time
import threading
import sys
from tracely.tracer import observe, init, _send_queue

# Mock remote config to enable background sender logic
init(api_key="test-key", endpoint="http://localhost:9999")

@observe
def rapid_fire(i):
    return f"result {i}"

def monitor_queue():
    while True:
        size = _send_queue.qsize()
        print(f"\rQueue size: {size}    ", end="", file=sys.stderr)
        time.sleep(0.1)

if __name__ == "__main__":
    t = threading.Thread(target=monitor_queue, daemon=True)
    t.start()

    print("Firing 2000 traces rapidly...")
    start = time.time()
    for i in range(2000):
        rapid_fire(i)
    end = time.time()

    print(f"\nFinished firing in {end-start:.2f} seconds")
    print(f"Final queue size: {_send_queue.qsize()}")
    print("Wait 1 second for any logs...")
    time.sleep(1)
