import contextlib
import io
import unittest
from unittest.mock import patch

import swarmtrace.pricing as pricing
from swarmtrace.pricing import calculate_cost
from swarmtrace.tracer import _safe_flush


class TestReliability(unittest.TestCase):
    def _reset_pricing_cache(self):
        original_cache = pricing._cache
        original_ts = pricing._cache_ts

        def restore():
            pricing._cache = original_cache
            pricing._cache_ts = original_ts

        self.addCleanup(restore)
        pricing._cache = {}
        pricing._cache_ts = 0.0

    def test_pricing_fetch_failure(self):
        self._reset_pricing_cache()
        with patch('urllib.request.urlopen', side_effect=Exception("Network Down")):
            # Run the fetch synchronously so the failure path is deterministic
            # (the hot path only ever triggers it on a background thread).
            pricing._background_fetch()
        self.assertEqual(pricing._cache, {})
        # A failed fetch must never raise into the caller and must yield $0
        # rather than a guessed cost.
        cost = calculate_cost("gpt-4", 1000, 1000)
        self.assertEqual(cost, 0.0)

    def test_tracer_storage_failure(self):
        stderr = io.StringIO()
        with patch('swarmtrace.tracer._flush', side_effect=Exception("DB Corrupted")):
            with contextlib.redirect_stderr(stderr):
                _safe_flush(
                    "id", None, "func", [], {}, "out", 0.1, None, "ts",
                    0, 0, 0.0, "auto", "agent-id", "agent-name",
                )
        self.assertIn("trace flush warning", stderr.getvalue())
        self.assertIn("DB Corrupted", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
