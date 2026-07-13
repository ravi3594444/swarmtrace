"""Regression tests for FOV credential redaction.

Bug: when FOV tracing was enabled, the Playwright method wrapper in
fov.py recorded every positional argument verbatim — including the
VALUE arg of fill()/type()/press()/select_option(). So code like::

    page.fill("#password", "CorrectHorseBatteryStaple!")

produced a browser 'started' event with:

    {"method": "fill", "args": ["#password", "CorrectHorseBatteryStaple!"]}

which was then persisted to local SQLite, queued for remote /api/events
ingest, and ultimately stored in Supabase — all without any redaction.
The existing redact() module was never imported by fov.py at all, so
this wasn't a "redactor missed it" gap; the FOV browser-event path
simply bypassed redaction entirely. A raw password like
"CorrectHorseBatteryStaple!" matches none of redact()'s patterns (no
email shape, no API-key prefix, no Luhn-valid card number, no JWT
shape), so even wiring redact() in alone wouldn't have caught it.

Fix: _redact_browser_args() adds two layers —
  1. Field-aware: for value methods (fill/type/press/select_option),
     if the SELECTOR names a sensitive field (password, token, secret,
     api_key, auth, cookie, session, etc.), the VALUE arg is replaced
     with [REDACTED] before the event is built. This catches raw
     passwords and custom tokens that have no pattern shape.
  2. Pattern-based (defense-in-depth): every arg also runs through
     redact() to catch API keys / JWTs / emails / cards embedded in
     any position.

URLs captured on 'done' and 'screen_tick' events also have their
query strings and fragments stripped via _redact_url(), since those
routine carry session tokens, OAuth codes, and access tokens.

These tests lock both layers in place.
"""

from __future__ import annotations

import swarmtrace.fov as fov


# ---------------------------------------------------------------------------
# Field-aware redaction — the high-value layer that catches raw passwords
# ---------------------------------------------------------------------------

def test_fill_password_value_is_redacted():
    """The exact reproduction from the security report: page.fill('#password',
    'CorrectHorseBatteryStaple!') must NOT persist the password."""
    out = fov._redact_browser_args("fill", ("#password", "CorrectHorseBatteryStaple!"))
    assert out == ["#password", "[REDACTED]"]


def test_type_password_value_is_redacted():
    """type() is also a value method — same redaction."""
    out = fov._redact_browser_args("type", ("#password", "hunter2"))
    assert out == ["#password", "[REDACTED]"]


def test_fill_token_selector_redacts_value():
    """Selector names a token field — value is redacted even though the
    value itself has no recognizable pattern."""
    out = fov._redact_browser_args("fill", ('input[name="user_token"]', "tok_xyz_abc"))
    assert out[0] == 'input[name="user_token"]'
    assert out[1] == "[REDACTED]"


def test_fill_secret_selector_redacts_value():
    out = fov._redact_browser_args("fill", ("#client_secret", "super-secret-value"))
    assert out == ["#client_secret", "[REDACTED]"]


def test_fill_apikey_selector_redacts_value():
    # Covers api_key, api-key, apikey spellings.
    for sel in ("#api_key", "#api-key", "#apiKey"):
        out = fov._redact_browser_args("fill", (sel, "AIzaSyA" + "a" * 35))
        assert out[1] == "[REDACTED]", f"selector {sel!r} did not trigger redaction: {out}"


def test_fill_auth_cookie_session_selectors_redact_value():
    for sel in ("#auth_token", "#authorization", "#session_cookie", "#csrf_session"):
        out = fov._redact_browser_args("fill", (sel, "some-value"))
        assert out[1] == "[REDACTED]", f"selector {sel!r} did not trigger redaction: {out}"


def test_fill_non_sensitive_field_preserves_value():
    """False-positive check: a non-sensitive field's value MUST pass through
    unchanged. Over-redacting normal form fields would make the FOV dashboard
    useless for debugging."""
    out = fov._redact_browser_args("fill", ("#username", "ravi"))
    assert out == ["#username", "ravi"]
    out = fov._redact_browser_args("fill", ("#search", "hello world"))
    assert out == ["#search", "hello world"]


def test_click_is_not_value_redacted():
    """click() is not in _VALUE_METHODS — its args should pass through
    (subject only to pattern-based redaction, which doesn't match a bare
    selector)."""
    out = fov._redact_browser_args("click", ("#submit",))
    assert out == ["#submit"]


def test_select_option_value_redacted_for_sensitive_selector():
    out = fov._redact_browser_args("select_option", ("#security_question", "my_first_pet"))
    assert out == ["#security_question", "[REDACTED]"]


def test_case_insensitive_selector_match():
    """Password, PASSWORD, PassWord all match."""
    for sel in ("#Password", "#PASSWORD", "#passWORD"):
        out = fov._redact_browser_args("fill", (sel, "secret"))
        assert out[1] == "[REDACTED]", f"selector {sel!r} did not trigger redaction"


# ---------------------------------------------------------------------------
# Pattern-based defense-in-depth — catches API keys / JWTs / emails / cards
# in ANY arg position (not just sensitive selectors)
# ---------------------------------------------------------------------------

def test_api_key_in_selector_is_pattern_redacted():
    """An API key embedded in any arg position is redacted by the pattern
    layer, even when the method is not a value method."""
    out = fov._redact_browser_args(
        "click",
        ('[aria-label="ghp_' + "a" * 36 + '"]',),
    )
    assert "[REDACTED]" in out[0]


def test_jwt_in_arg_is_pattern_redacted():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    out = fov._redact_browser_args("fill", ("#note", jwt))
    # #note is not sensitive, so the value passes field-aware redaction,
    # but the pattern layer should still scrub the JWT.
    assert out[0] == "#note"
    assert "[REDACTED]" in out[1]
    assert jwt not in out[1]


def test_email_in_arg_is_pattern_redacted():
    out = fov._redact_browser_args("fill", ("#username", "user@example.com"))
    # Field-aware doesn't trigger (#username isn't sensitive), but the
    # pattern layer redacts the email.
    assert "[REDACTED]" in out[1]
    assert "user@example.com" not in out[1]


def test_field_aware_wins_over_pattern_for_sensitive_value():
    """When BOTH layers apply (sensitive selector AND pattern-matchable
    value), field-aware short-circuits so we get a clean [REDACTED] rather
    than the pattern layer seeing the value at all."""
    # An API-key-shaped value being typed into a password field.
    out = fov._redact_browser_args("type", ("#password", "sk-ant-" + "x" * 30))
    assert out == ["#password", "[REDACTED]"]


# ---------------------------------------------------------------------------
# URL redaction — query strings and fragments carry tokens
# ---------------------------------------------------------------------------

def test_redact_url_strips_query_string():
    assert fov._redact_url("https://example.com/login?session=abc123") == "https://example.com/login"


def test_redact_url_strips_oauth_code():
    assert fov._redact_url("https://example.com/callback?code=oauth_xyz") == "https://example.com/callback"


def test_redact_url_strips_fragment():
    """SPAs put access tokens in URL fragments (#access_token=...)."""
    assert fov._redact_url("https://example.com/app#access_token=eyJxyz") == "https://example.com/app"


def test_redact_url_strips_fragment_with_jwt():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
    assert fov._redact_url(f"https://example.com/app#access_token={jwt}") == "https://example.com/app"


def test_redact_url_preserves_clean_url():
    assert fov._redact_url("https://example.com/path") == "https://example.com/path"


def test_redact_url_handles_empty():
    assert fov._redact_url("") == ""
    assert fov._redact_url(None) == ""


def test_redact_url_strips_at_first_query_or_fragment():
    """If both ? and # appear, cut at whichever comes first."""
    assert fov._redact_url("https://example.com/a?x=1#y=2") == "https://example.com/a"
    assert fov._redact_url("https://example.com/a#y=2?x=1") == "https://example.com/a"


# ---------------------------------------------------------------------------
# End-to-end: the wrapped method actually emits redacted events
# ---------------------------------------------------------------------------

def test_wrapped_fill_emits_redacted_event(monkeypatch):
    """Drive _wrap_sync_method with a fake Page and confirm the captured
    event has [REDACTED] for the password value — not the raw password.

    This is the test that would have FAILED on the original bug. It exercises
    the full code path: _wrap_sync_method → _redact_browser_args → _mk_event
    → _save_event (captured via monkeypatch).
    """
    captured_events: list[dict] = []
    monkeypatch.setattr(fov, "_save_event", lambda ev: captured_events.append(ev))
    monkeypatch.setattr(fov, "_register_page", lambda *a, **k: None)
    monkeypatch.setattr(fov, "_current_agent", lambda: ("agent-1", "rag_bot"))

    # Fake Page: fill() returns "ok" and exposes .url
    class FakePage:
        url = "https://example.com/login"
        def fill(self, selector, value):
            assert value == "CorrectHorseBatteryStaple!", \
                "redaction must not change what the real method receives"
            return "ok"

    orig_fill = FakePage.fill
    wrapped = fov._wrap_sync_method("fill", orig_fill)
    page = FakePage()
    result = wrapped(page, "#password", "CorrectHorseBatteryStaple!")
    assert result == "ok"

    # The real method got the real password (redaction is observability-only,
    # never changes behavior). Above assert already checked that.
    assert len(captured_events) == 2  # started + done

    started = captured_events[0]
    done = captured_events[1]

    # The password must NOT appear in either event's data.
    assert "CorrectHorseBatteryStaple" not in str(started), \
        f"password leaked into started event: {started}"
    assert "CorrectHorseBatteryStaple" not in str(done), \
        f"password leaked into done event: {done}"

    # The value arg must be [REDACTED].
    assert started["data"]["args"] == ["#password", "[REDACTED]"], started["data"]
    assert done["data"]["args"] == ["#password", "[REDACTED]"], done["data"]

    # URL on the done event must have its query string stripped.
    assert done["data"]["url"] == "https://example.com/login"
