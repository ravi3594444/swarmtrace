"""Unit tests for swarmtrace.redact — pure functions, no I/O.

Covers each PII category with realistic fake shapes:
  - emails (RFC-ish, with subaddressing and dotted domains)
  - API keys (one fake per provider prefix)
  - credit cards (real test PANs that pass Luhn, plus look-alikes that don't)
  - JWTs (header.payload.signature, base64url)

Plus the critical false-positive guard: a 16-digit trace ID and other
non-PII content (UUIDs, order numbers, hex hashes) must pass through
unredacted.
"""

from __future__ import annotations

import re
import unittest

from swarmtrace.redact import redact, luhn_ok


# --------------------------------------------------------------------------
# Test PANs — these are issuer-published test card numbers that pass Luhn
# but are NOT real accounts.  Safe to hardcode.  Pulled from Stripe's
# public testing docs and the classic "4111... Visa" test number.
# --------------------------------------------------------------------------
VISA_TEST_PAN       = "4111111111111111"          # 16-digit Visa test card
MASTERCARD_TEST_PAN = "5555555555554444"          # 16-digit Mastercard test card
AMEX_TEST_PAN       = "378282246310005"           # 15-digit Amex test card
DASHED_PAN          = "4111-1111-1111-1111"       # same as VISA_TEST_PAN, dashed
SPACED_PAN          = "4111 1111 1111 1111"       # same as VISA_TEST_PAN, spaced


class TestLuhn(unittest.TestCase):
    """Luhn checksum — the gate that separates real PANs from digit-look-alikes."""

    def test_known_test_pans_pass_luhn(self):
        for pan in (VISA_TEST_PAN, MASTERCARD_TEST_PAN, AMEX_TEST_PAN):
            self.assertTrue(luhn_ok(pan), f"{pan} should pass Luhn")

    def test_16_digit_trace_id_fails_luhn(self):
        # A 16-digit number that isn't a real PAN — this is the case the user
        # explicitly called out as "must pass through unredacted".  Real trace
        # IDs / order numbers / numeric IDs almost never pass Luhn by accident.
        self.assertFalse(luhn_ok("1234567890123456"))
        self.assertFalse(luhn_ok("9999999999999999"))
        self.assertFalse(luhn_ok("1357902468135790"))

    def test_too_short_fails(self):
        # 12-digit number — outside the 13–19 PAN range, Luhn is meaningless.
        self.assertFalse(luhn_ok("411111111111"))

    def test_too_long_fails(self):
        # 20-digit number — outside the 13–19 PAN range.
        self.assertFalse(luhn_ok("41111111111111111111"))

    def test_non_digits_rejected(self):
        self.assertFalse(luhn_ok("4111-1111-1111-1111"))
        self.assertFalse(luhn_ok("abcd"))
        self.assertFalse(luhn_ok(""))


class TestEmailRedaction(unittest.TestCase):
    def test_plain_email(self):
        out = redact("contact us at alice@example.com please")
        self.assertNotIn("alice@example.com", out)
        self.assertIn("[REDACTED]", out)

    def test_subaddressed_email(self):
        out = redact("send to bob+reports@sub.domain.co.uk")
        self.assertNotIn("bob+reports@sub.domain.co.uk", out)
        self.assertIn("[REDACTED]", out)

    def test_dotted_local_part(self):
        out = redact("first.last@company.io")
        self.assertNotIn("first.last@company.io", out)

    def test_multiple_emails_in_one_string(self):
        out = redact("from: a@x.com, to: b@y.com")
        self.assertNotIn("a@x.com", out)
        self.assertNotIn("b@y.com", out)
        self.assertEqual(out.count("[REDACTED]"), 2)

    def test_email_inside_args_repr_tuple(self):
        # Realistic shape: tracer._flush builds args_repr like "('alice@x.com',)"
        out = redact("('alice@x.com',)")
        self.assertNotIn("alice@x.com", out)
        self.assertIn("[REDACTED]", out)


class TestAPIKeyRedaction(unittest.TestCase):
    """One realistic fake per provider prefix.  None of these are real keys —
    they're long random alphanumeric strings matching the provider's format."""

    def test_openai_sk_prefix(self):
        # 48-char alphanumeric after "sk-" — looks like an OpenAI key
        key = "sk-" + "A" * 48
        out = redact(f"Authorization: Bearer {key}")
        self.assertNotIn(key, out)
        self.assertIn("[REDACTED]", out)

    def test_anthropic_sk_ant_prefix(self):
        key = "sk-ant-" + "B" * 50
        out = redact(f"x-api-key: {key}")
        self.assertNotIn(key, out)

    def test_github_pat_classic(self):
        # Classic GitHub PAT: ghp_ + 36 chars
        key = "ghp_" + "C" * 36
        out = redact(f"GH_TOKEN={key}")
        self.assertNotIn(key, out)

    def test_github_fine_grained(self):
        # Fine-grained GitHub PAT: github_pat_ + 82 chars
        key = "github_pat_" + "D" * 82
        out = redact(key)
        self.assertNotIn(key, out)

    def test_slack_bot_token(self):
        key = "xoxb-" + "E" * 24
        out = redact(f"SLACK_BOT_TOKEN={key}")
        self.assertNotIn(key, out)

    def test_aws_access_key_id(self):
        # AWS access key id: AKIA + 16 uppercase alnum
        key = "AKIA" + "F" * 16
        out = redact(f"aws_access_key_id = {key}")
        self.assertNotIn(key, out)

    def test_stripe_secret_live(self):
        key = "sk_live_" + "G" * 24
        out = redact(key)
        self.assertNotIn(key, out)

    def test_pypi_token(self):
        key = "pypi-AgEI" + "H" * 50
        out = redact(f"TWINE_PASSWORD = {key}")
        self.assertNotIn(key, out)

    def test_google_api_key(self):
        # Google API key: AIza + 35 chars (exact 39 total)
        key = "AIza" + "I" * 35
        out = redact(key)
        self.assertNotIn(key, out)

    def test_short_sk_prefix_not_redacted(self):
        # "sk-abc" is too short to be a real key — must NOT be redacted.
        out = redact("just a prefix sk-abc here")
        self.assertIn("sk-abc", out)
        self.assertNotIn("[REDACTED]", out)


class TestJWTRedaction(unittest.TestCase):
    # A real-shaped fake JWT (header.payload.signature, all base64url).
    # Header decodes to {"alg":"HS256","typ":"JWT"} — the standard shape.
    FAKE_JWT = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ."
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )

    def test_jwt_in_bearer_header(self):
        out = redact(f"Authorization: Bearer {self.FAKE_JWT}")
        self.assertNotIn(self.FAKE_JWT, out)
        self.assertIn("[REDACTED]", out)

    def test_jwt_alone(self):
        out = redact(self.FAKE_JWT)
        self.assertNotIn(self.FAKE_JWT, out)
        self.assertEqual(out, "[REDACTED]")

    def test_non_jwt_eyJ_passthrough(self):
        # "eyJfoo" alone (no dots) is not a JWT — must pass through.
        out = redact("just the prefix eyJfoo bar")
        self.assertIn("eyJfoo", out)


class TestCreditCardRedaction(unittest.TestCase):
    def test_visa_16_digit(self):
        out = redact(f"card number: {VISA_TEST_PAN}")
        self.assertNotIn(VISA_TEST_PAN, out)
        self.assertIn("[REDACTED]", out)

    def test_mastercard_16_digit(self):
        out = redact(f"pan={MASTERCARD_TEST_PAN}")
        self.assertNotIn(MASTERCARD_TEST_PAN, out)

    def test_amex_15_digit(self):
        out = redact(f"amex: {AMEX_TEST_PAN}")
        self.assertNotIn(AMEX_TEST_PAN, out)

    def test_dashed_separator(self):
        out = redact(f"card = {DASHED_PAN}")
        self.assertNotIn(DASHED_PAN, out)
        self.assertNotIn("4111", out)  # no digit fragments leak

    def test_space_separator(self):
        out = redact(f"card = {SPACED_PAN}")
        self.assertNotIn(SPACED_PAN, out)

    def test_multiple_cards_in_one_string(self):
        out = redact(f"{VISA_TEST_PAN} and {MASTERCARD_TEST_PAN}")
        self.assertNotIn(VISA_TEST_PAN, out)
        self.assertNotIn(MASTERCARD_TEST_PAN, out)
        self.assertEqual(out.count("[REDACTED]"), 2)


class TestNonPIIPassThrough(unittest.TestCase):
    """Critical: non-PII content that *looks* PII-shaped must NOT be redacted.
    This is the false-positive guard the user explicitly called out."""

    def test_16_digit_trace_id_passes_through(self):
        # The exact case from the user's spec — a 16-digit trace ID is
        # NOT Luhn-valid, so it must pass through unredacted.
        trace_id = "1234567890123456"
        self.assertEqual(redact(trace_id), trace_id)
        self.assertEqual(redact(f"trace={trace_id}"), f"trace={trace_id}")

    def test_uuid_hex_passes_through(self):
        # swarmtrace trace_id is uuid4().hex — 32 hex chars.  Contains
        # letters a-f so the CC regex won't match it as a contiguous digit
        # run, and even if it did, Luhn would fail.
        trace_id = "0123456789abcdef0123456789abcdef"
        self.assertEqual(redact(trace_id), trace_id)

    def test_sha256_hash_passes_through(self):
        # Stable agent_id is sha256 hex — 64 chars of [0-9a-f].  Same logic
        # as UUID: contains letters so CC regex skips it; doesn't start with
        # any API-key prefix; doesn't start with eyJ; no @ sign.
        h = "e" * 64
        self.assertEqual(redact(h), h)
        h2 = "a1b2c3d4e5f6" * 5 + "a1b2c3d4"  # 64 chars
        self.assertEqual(redact(h2), h2)

    def test_short_numeric_id_passes_through(self):
        # A 7-digit order ID — below the 13-digit PAN minimum.
        self.assertEqual(redact("order #1234567"), "order #1234567")

    def test_phone_number_not_redacted(self):
        # Phone numbers are deliberately NOT scrubbed (per module docstring).
        # A 10-digit phone number is below the 13-digit PAN minimum, so even
        # if it were a candidate, it wouldn't be Luhn-gated.
        self.assertEqual(redact("call me at 555-123-4567"), "call me at 555-123-4567")

    def test_20_digit_id_passes_through(self):
        # 20-digit number — above the 19-digit PAN max, so not a candidate.
        big_id = "1" * 20
        self.assertEqual(redact(big_id), big_id)

    def test_plain_text_unchanged(self):
        # Plain English with no PII — completely unchanged.
        msg = "the agent ran successfully and returned 5 results"
        self.assertEqual(redact(msg), msg)

    def test_code_like_string_unchanged(self):
        # Args repr from tracer: "('hello', 42)" — no PII, unchanged.
        s = "('hello', 42)"
        self.assertEqual(redact(s), s)

    def test_model_token_counts_unchanged(self):
        # auto_instrument.py builds strings like "model=gpt-4 tokens=100in/50out"
        # — no PII, must pass through.  (We don't redact in auto_instrument.py
        # per the user's instructions, but tracer._flush args_repr shouldn't
        # mangle this shape either if it shows up in args.)
        s = "model=gpt-4 tokens=100in/50out"
        self.assertEqual(redact(s), s)


class TestEdgeCases(unittest.TestCase):
    def test_none_passes_through(self):
        self.assertIsNone(redact(None))

    def test_empty_string_passes_through(self):
        self.assertEqual(redact(""), "")

    def test_non_string_coerced(self):
        # Numbers, lists, etc. — coerced via str() first.
        self.assertEqual(redact(42), "42")
        self.assertEqual(redact([1, 2, 3]), "[1, 2, 3]")

    def test_idempotent(self):
        # Redacting an already-redacted string is a no-op — "[REDACTED]"
        # doesn't match any of the four patterns.
        once = redact("email is alice@example.com and key is sk-" + "A" * 48)
        twice = redact(once)
        self.assertEqual(once, twice)

    def test_mixed_pii_in_one_string(self):
        # All four categories in one string — all should be scrubbed.
        s = (
            f"contact: alice@example.com | "
            f"key: sk-{'A' * 48} | "
            f"card: {VISA_TEST_PAN} | "
            f"jwt: {TestJWTRedaction.FAKE_JWT}"
        )
        out = redact(s)
        self.assertNotIn("alice@example.com", out)
        self.assertNotIn("sk-" + "A" * 48, out)
        self.assertNotIn(VISA_TEST_PAN, out)
        self.assertNotIn(TestJWTRedaction.FAKE_JWT, out)
        # Four distinct PII items → four redaction markers.
        self.assertEqual(out.count("[REDACTED]"), 4)

    def test_redacted_marker_doesnt_grow(self):
        # If we run redact on a string that already contains "[REDACTED]"
        # (e.g. from a previous call), the marker itself must not be
        # re-redacted or expanded.
        s = "args = [REDACTED] result = 5"
        self.assertEqual(redact(s), s)


class TestRealisticShapesFromTracer(unittest.TestCase):
    """End-to-end-shape tests: the actual string formats that flow through
    tracer._flush — args_repr, output, error — with PII embedded."""

    def test_args_repr_with_email_arg(self):
        # tracer._flush builds: args_repr = str(args[:2])
        args_repr = "('alice@example.com', 'please help me')"
        out = redact(args_repr)
        self.assertNotIn("alice@example.com", out)
        self.assertIn("[REDACTED]", out)
        self.assertIn("please help me", out)

    def test_output_with_credit_card(self):
        output = f"Your card ending in 1111 was charged. Full PAN for log: {VISA_TEST_PAN}"
        out = redact(output)
        self.assertNotIn(VISA_TEST_PAN, out)
        self.assertIn("ending in 1111", out)

    def test_error_with_api_key(self):
        # Realistic shape: an LLM API error that echoes the key back.
        key = "sk-ant-" + "X" * 50
        error = f"AuthenticationError: invalid api key '{key}' (status 401)"
        out = redact(error)
        self.assertNotIn(key, out)
        self.assertIn("[REDACTED]", out)
        self.assertIn("AuthenticationError", out)

    def test_output_with_jwt_session_token(self):
        output = f"session established, token={TestJWTRedaction.FAKE_JWT}"
        out = redact(output)
        self.assertNotIn(TestJWTRedaction.FAKE_JWT, out)


if __name__ == "__main__":
    unittest.main()
