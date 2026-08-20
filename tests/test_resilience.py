import unittest
from unittest.mock import patch

from swarmtrace import pricing
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
        # A failed fetch must never raise into the caller; bundled pricing
        # still provides a nonzero fallback for known models, while unknown
        # ones stay 0.
        cost = calculate_cost("gpt-4", 1000, 1000)
        unknown_cost = calculate_cost("definitely-not-a-real-model", 1000, 1000)
        self.assertAlmostEqual(cost, 0.09, places=2)
        self.assertEqual(unknown_cost, 0.0)

    def test_tracer_storage_failure(self):
        # When _flush raises, _safe_flush must (a) not re-raise and (b) emit
        # a warning containing "trace flush warning" and the exception message.
        # Originally verified via redirect_stderr (because the impl used
        # print(file=sys.stderr)); now verified via assertLogs because the
        # impl uses logging.getLogger("swarmtrace") per the library's
        # logging policy (no handlers attached — host app's decision).
        with (
            patch('swarmtrace.tracer._flush', side_effect=Exception("DB Corrupted")),
            self.assertLogs("swarmtrace", level="WARNING") as cm,
        ):
            _safe_flush(
                "id", None, "func", [], {}, "out", 0.1, None, "ts",
                0, 0, 0.0, "auto", "agent-id", "agent-name",
            )
        joined = "\n".join(cm.output)
        self.assertIn("trace flush warning", joined)
        self.assertIn("DB Corrupted", joined)


if __name__ == "__main__":
    unittest.main()
