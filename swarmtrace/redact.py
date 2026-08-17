"""PII redaction — pure functions, no dependencies.

Used by :func:`swarmtrace.tracer._flush` to scrub PII from ``args``,
``output``, and ``error`` *before* they hit either the local SQLite DB
or the remote ingest endpoint.  Redacting in ONE place (the ``_flush``
call site) means local and remote never disagree about what was stored.

Pure functions
--------------
Every function here takes a string (or ``None``) and returns a string
(or ``None``).  No I/O, no global state, no exceptions, no imports beyond
the standard library.  This keeps the module unit-testable in isolation
and safe to call from the hot tracing path.

Categories scrubbed
-------------------
1. **Emails** — RFC-ish ``local@domain.tld`` shape.
2. **API-key-shaped strings** — well-known provider prefixes
   (``sk-``, ``sk-ant-``, ``ghp_``, ``xox[bpoa]-``, ``AKIA``, ``AIza``,
   ``pypi-AgEI``, ``sk_live_``, ``sk_test_``, ``rk_live_``) followed by
   a length gate so a bare ``"sk-"`` doesn't match.
3. **Credit card numbers** — digit groups (13–19 digits, separators
   allowed) that pass the **Luhn check**.  A bare regex would also catch
   16-digit trace IDs, UUID fragments, and numeric IDs; Luhn is what
   separates real card numbers from those.
4. **JWTs** — three base64url segments ``eyJ….….…`` (the ``eyJ`` prefix
   is ``{"`` base64-encoded, so every JWT header starts with it).

What is NOT scrubbed
--------------------
- Phone numbers (too locale-dependent, false-positive prone).
- SSNs (region-specific; add if/when a customer asks).
- Street addresses (no compact regex shape).
- Generic "long random strings" (no reliable signal — would either
  over-match API nonces or under-match custom tokens).
"""

from __future__ import annotations

import re
from typing import overload

__all__ = ["luhn_ok", "redact"]


# --------------------------------------------------------------------------
# Patterns
# --------------------------------------------------------------------------

# Email — local part allows dots, +, -, _, %, alnum.  Domain is alnum + dots,
# TLD ≥ 2 alpha chars.  Good enough for the realistic shapes that show up in
# LLM prompts and tool args; we're not trying to validate per-RFC-5322.
_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
)

# API key prefixes — curated set of well-known provider formats.  Each
# alternative has a length gate after the prefix so a 3-char "sk-" alone
# can't match.  Alternatives, in order of specificity (longest prefix first
# so e.g. ``sk-ant-`` wins over ``sk-``):
#
#   sk-ant-[A-Za-z0-9_\-]{20,}      Anthropic
#   sk-[A-Za-z0-9_\-]{20,}          OpenAI / OpenAI-compatible
#   gh[pousr]_[A-Za-z0-9]{36,}      GitHub PAT (classic — 40 chars total)
#   github_pat_[A-Za-z0-9_]{82,}    GitHub fine-grained (93 chars total)
#   xox[bpoa]-[A-Za-z0-9\-]{10,}    Slack
#   AKIA[0-9A-Z]{16}                AWS access key id (exact 20 chars)
#   sk_(?:live|test)_[A-Za-z0-9]{24,}  Stripe secret key
#   rk_live_[A-Za-z0-9]{24,}        Stripe restricted key
#   pypi-AgEI[A-Za-z0-9_\-]{20,}    PyPI API token
#   AIza[0-9A-Za-z_\-]{35}          Google API key (exact 39 chars)
#
# Length gates are deliberately generous — false negatives (missing a real
# key) are worse than false positives (redacting a 36-char alphanumeric
# string that happens to start with ``ghp_`` but isn't actually a PAT).
_API_KEY_RE = re.compile(
    r"\b("
    r"sk-ant-[A-Za-z0-9_\-]{20,}"
    r"|sk-[A-Za-z0-9_\-]{20,}"
    r"|gh[pousr]_[A-Za-z0-9]{36,}"
    r"|github_pat_[A-Za-z0-9_]{82,}"
    r"|xox[bpoa]-[A-Za-z0-9\-]{10,}"
    r"|AKIA[0-9A-Z]{16}"
    r"|sk_(?:live|test)_[A-Za-z0-9]{24,}"
    r"|rk_live_[A-Za-z0-9]{24,}"
    r"|pypi-AgEI[A-Za-z0-9_\-]{20,}"
    r"|AIza[0-9A-Za-z_\-]{35}"
    r")"
)

# JWT — three base64url segments separated by dots.  Header always starts
# with ``eyJ`` because that's ``{"`` base64-encoded.  Standard JWT shape;
# we don't try to decode/verify, just match the shape and redact.
_JWT_RE = re.compile(
    r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b"
)

# Candidate credit card numbers — a solid run of 13-19 digits, OR digits
# grouped with a single *uniform* separator (space or dash) in one of the
# standard PAN groupings: 4-4-4-{1..7} (Visa/Mastercard/Discover/etc.,
# covers 13-19 total digits) or 4-6-5 (Amex, 15 digits). Every alternative
# starts and ends on a digit — never on a separator — so a match can never
# eat a trailing space/dash or bleed into an adjacent unrelated digit
# (previously `(?:\d[ -]?){13,19}` could consume one extra char past the
# number, silently deleting data, and could fuse two space-separated cards
# into a single match).
_CC_CANDIDATE_RE = re.compile(
    r"\b\d{13,19}\b"
    r"|\b\d{4}([ -])\d{6}\1\d{5}\b"
    r"|\b\d{4}([ -])\d{4}\2\d{4}\2\d{1,7}\b"
)


_REDACTED = "[REDACTED]"


# --------------------------------------------------------------------------
# Luhn check (public — exported for tests + reuse)
# --------------------------------------------------------------------------

def luhn_ok(digits: str) -> bool:
    """Return ``True`` iff *digits* passes the Luhn checksum.

    *digits* must contain only digit characters (callers typically strip
    spaces/dashes first).  Length must be 13–19 — the ISO/IEC 7812 range
    for payment card primary account numbers.  Outside that range, Luhn
    is meaningless, so we return ``False`` rather than running the math.

    The algorithm: starting from the leftmost digit, double every
    second digit (if the result is > 9, subtract 9), sum all digits,
    and check the total is divisible by 10.  This is the standard
    Luhn formula used by every major card network (Visa, Mastercard,
    Amex, Discover, JCB, UnionPay).
    """
    if not digits or not digits.isdigit():
        return False
    if len(digits) < 13 or len(digits) > 19:
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# --------------------------------------------------------------------------
# Per-category redactors
# --------------------------------------------------------------------------

def _redact_credit_cards(text: str) -> str:
    """Replace Luhn-valid digit groups with ``[REDACTED]``.

    Non-Luhn candidates (e.g. a 16-digit trace ID, a 13-digit order
    number) pass through unchanged.  This is the deliberate distinction
    from a bare-regex approach — the user explicitly asked for
    Luhn-checked, not bare regex, so non-card numbers don't get
    accidentally scrubbed.
    """
    def replace(m: re.Match[str]) -> str:
        raw = m.group(0)
        digits = re.sub(r"[^0-9]", "", raw)
        return _REDACTED if luhn_ok(digits) else raw
    return _CC_CANDIDATE_RE.sub(replace, text)


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------

@overload
def redact(text: str) -> str: ...


@overload
def redact(text: None) -> None: ...


def redact(text: str | None) -> str | None:
    """Scrub emails, API keys, credit card numbers, and JWTs from *text*.

    Overloaded so ``None`` in means ``None`` out and ``str`` in means ``str``
    out. Without the overloads the declared return is ``str | None`` for every
    caller, and the two call sites that slice the result directly —
    ``redact(str(x))[:32000]`` in ``otlp_mapping`` and the ``args``/``output``/
    ``error`` reassignments in ``tracer._flush`` — are unprovable to a type
    checker even though they are safe at runtime. The overloads make that
    safety checkable rather than assumed.

    - ``None`` passes through unchanged (so ``tracer._flush`` can call
      ``redact(output)`` even when output is ``None``).
    - Non-string inputs are coerced via ``str()`` first.
    - Empty strings return as empty strings.
    - Idempotent: redacting an already-redacted string is a no-op
      (``[REDACTED]`` doesn't match any of the four patterns).

    The order of operations matters slightly: emails first (so the
    ``@`` doesn't accidentally become part of a JWT-like sequence),
    then API keys (longest prefix first within the alternation), then
    JWTs, then credit cards (Luhn-checked).  In practice the four
    categories don't overlap, but the order is defensive.
    """
    if text is None:
        return None
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return text
    text = _EMAIL_RE.sub(_REDACTED, text)
    text = _API_KEY_RE.sub(_REDACTED, text)
    text = _JWT_RE.sub(_REDACTED, text)
    text = _redact_credit_cards(text)
    return text
