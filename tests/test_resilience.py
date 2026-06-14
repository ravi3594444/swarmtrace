import unittest
from unittest.mock import patch, MagicMock
from tracely.pricing import _fetch_live, calculate_cost
import json

class TestReliability(unittest.TestCase):
    def test_pricing_fetch_failure(self):
        # Force a network failure
        with patch('urllib.request.urlopen', side_effect=Exception("Network Down")):
            # Clear cache
            import tracely.pricing as pricing
            pricing._cache = {}
            pricing._cache_ts = 0.0

            data = _fetch_live()
            self.assertEqual(data, {})

            # Cost should be 0 instead of crashing
            cost = calculate_cost("gpt-4", 1000, 1000)
            self.assertEqual(cost, 0.0)

    def test_tracer_storage_failure(self):
        # Test if tracer handles storage errors gracefully (already partially covered by existing tests, but let's be sure)
        from tracely.tracer import _safe_flush
        with patch('tracely.tracer._flush', side_effect=Exception("DB Corrupted")):
            # This should not raise
            _safe_flush("id", None, "func", [], {}, "out", 0.1, None, "ts", 0, 0, 0.0)

if __name__ == "__main__":
    unittest.main()
