"""Regression tests for the regression.py score_similarity() crash bug.

Bug: `score = llm(prompt).strip()` and `float(score)` shared one try, with
`except ValueError` referencing `score` to log a friendly warning. If the
user-supplied llm callable raised ValueError before `score` was ever
assigned (network/SDK error, bad args, etc.), the except block itself threw
UnboundLocalError — uncaught by the sibling `except Exception` — crashing
compare() entirely and defeating the documented "never crash, default to
0.5" guarantee.

Fix: the llm() call and the float parse are now in two separate try/except
blocks, so the parsing except can never reference a value the call-failure
except already returned out of.
"""

import swarmtrace.regression as regression


def test_llm_raising_value_error_falls_back_to_neutral():
    """The exact crash scenario: llm() itself raises ValueError before any
    score is assigned.
    """
    def broken_llm(prompt):
        raise ValueError("simulated SDK error")

    assert regression.score_similarity("a", "b", llm=broken_llm) == 0.5


def test_llm_raising_other_exception_falls_back_to_neutral():
    def broken_llm(prompt):
        raise ConnectionError("network down")

    assert regression.score_similarity("a", "b", llm=broken_llm) == 0.5


def test_non_numeric_output_falls_back_to_neutral():
    assert regression.score_similarity("a", "b", llm=lambda p: "not a number") == 0.5


def test_none_output_falls_back_to_neutral():
    assert regression.score_similarity("a", "b", llm=lambda p: None) == 0.5


def test_valid_numeric_output_is_used_and_clamped():
    assert regression.score_similarity("a", "b", llm=lambda p: "0.75") == 0.75
    assert regression.score_similarity("a", "b", llm=lambda p: "5") == 1.0     # clamped
    assert regression.score_similarity("a", "b", llm=lambda p: "-3") == 0.0    # clamped


def test_compare_does_not_crash_when_scoring_fails(monkeypatch):
    """End-to-end: a broken scorer must not blow up compare()."""
    def broken_llm(prompt):
        raise ValueError("simulated SDK error")

    def fake_func(input_text, prompt):
        return f"{prompt}:{input_text}"

    regressions = regression.compare(
        fake_func,
        inputs=["hello"],
        version_a_prompt="v1",
        version_b_prompt="v2",
        llm=broken_llm,
    )
    # similarity defaults to 0.5, threshold is 0.6 -> counts as a regression,
    # but the key thing is it ran at all instead of crashing.
    assert regressions == 1
