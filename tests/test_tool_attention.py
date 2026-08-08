"""Tests for swarmtrace/tool_attention.py.

Audit finding #8: tool_attention.py had zero test coverage.
Audit finding #12: add_tools() was O(n²) — rebuilt the entire index
on every call instead of incremental add. This test file covers both
the existing select() behavior and the new incremental add_tools().

`sentence-transformers`, `faiss-cpu`, and `numpy` are optional
dependencies (`pip install swarmtrace[tools]`) and are not installed
in the base test environment. These tests inject fakes into sys.modules
to exercise the real ToolAttention logic without the heavy ML deps.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest

import swarmtrace.tool_attention as ta

# ---------------------------------------------------------------------------
# Fake optional dependencies (numpy, sentence_transformers, faiss)
# ---------------------------------------------------------------------------

class _FakeIndex:
    """Stands in for faiss.IndexFlatL2. Tracks .add() calls so tests can
    assert incremental adds happened (not full rebuilds)."""

    def __init__(self, dim):
        self.dim = dim
        self.added_embeddings = []  # list of np-array-like objects passed to .add()
        self.search_calls = []

    def add(self, embeddings):
        # Record what was added — tests check len() to verify incremental.
        self.added_embeddings.append(embeddings)

    def search(self, query_vec, k):
        # Return (distances, indices) — fake uniform results.
        self.search_calls.append((query_vec, k))
        import numpy as np
        distances = np.zeros((1, k), dtype="float32")
        indices = np.array([[i for i in range(min(k, 999))]], dtype="int64")
        return distances, indices


def _install_fake_deps():
    """Inject fake numpy, sentence_transformers, faiss into sys.modules."""
    # Real numpy for array operations (it's lightweight enough to use directly
    # in tests, and the fakes need to return real numpy arrays for .astype()
    # and .vstack() to work). If numpy isn't installed, skip these tests.
    np = pytest.importorskip("numpy")

    # Fake sentence_transformers
    fake_st = types.ModuleType("sentence_transformers")

    class _FakeSentenceTransformer:
        def __init__(self, model_name):
            self.model_name = model_name

        def encode(self, texts, convert_to_numpy=True):
            # Return deterministic fake embeddings: one row per text,
            # dim=8 (small for test speed). Each text gets a unique
            # embedding based on its content hash so different tools
            # get different vectors.
            dim = 8
            if isinstance(texts, str):
                texts = [texts]
            embeddings = np.zeros((len(texts), dim), dtype="float32")
            for i, text in enumerate(texts):
                # Simple deterministic embedding from text content
                for j, ch in enumerate(text[:dim]):
                    embeddings[i][j % dim] += ord(ch) / 256.0
            return embeddings

    fake_st.SentenceTransformer = _FakeSentenceTransformer

    # Fake faiss
    fake_faiss = types.ModuleType("faiss")
    fake_faiss.IndexFlatL2 = _FakeIndex

    sys.modules["sentence_transformers"] = fake_st
    sys.modules["faiss"] = fake_faiss

    return np, fake_st, fake_faiss


def _remove_fake_deps():
    for mod in ("sentence_transformers", "faiss"):
        sys.modules.pop(mod, None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fake_deps():
    """Install fake numpy/st/faiss for the test, clean up after."""
    pytest.importorskip("numpy")
    _install_fake_deps()
    yield
    _remove_fake_deps()


@pytest.fixture()
def sample_tools():
    return [
        {"name": "search_web", "description": "Search the web", "schema": {"type": "object"}},
        {"name": "calculator", "description": "Do math", "schema": {"type": "object"}},
        {"name": "email_sender", "description": "Send emails", "schema": {"type": "object"}},
    ]


@pytest.fixture()
def records(monkeypatch, fake_runtime):
    """Capture spans through the Phase 1 runtime seam (get_runtime().record())
    instead of patching the removed ta.save_trace. tool_attention.py was
    migrated to SpanRecord + get_runtime().record() (PRD Phase 1); this
    fixture patches fake_runtime.repository.save (the pattern already used
    in tests/test_run.py) and stores each span via to_storage_dict() so the
    existing row["kind"] / row["function"] assertions keep working unchanged.
    """
    saved = []

    def _capture(span):
        fake_runtime.repository.spans.append(span)
        saved.append(span.to_storage_dict())

    monkeypatch.setattr(fake_runtime.repository, "save", _capture)
    return saved


# ---------------------------------------------------------------------------
# Tests — __init__ + _build_index
# ---------------------------------------------------------------------------

def test_build_index_succeeds_with_deps(fake_deps, sample_tools):
    """ToolAttention constructs without error when deps are available."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    assert att._index is not None
    assert att._model is not None
    assert att._embeddings is not None
    assert len(att.tools) == 3


def test_build_index_import_error_gives_helpful_message(monkeypatch, sample_tools):
    """Without deps, the error message tells the user what to install."""
    # Ensure deps are NOT available
    _remove_fake_deps()
    # Also block numpy if it's installed — _build_index imports it
    monkeypatch.setitem(__import__('sys').modules, 'numpy', None)

    with pytest.raises(ImportError, match="sentence-transformers"):
        ta.ToolAttention(sample_tools, verbose=False)


# ---------------------------------------------------------------------------
# Tests — add_tools (audit finding #12: incremental, not rebuild)
# ---------------------------------------------------------------------------

def test_add_tools_is_incremental_not_rebuild(fake_deps, sample_tools):
    """Audit finding #12: add_tools() must NOT call _build_index().

    The old impl called _build_index() which re-encoded every tool from
    scratch. The fix encodes only the new tools and uses index.add().
    This test verifies _build_index is NOT called during add_tools by
    spying on it.
    """
    att = ta.ToolAttention(sample_tools, verbose=False)
    _build_calls_before = att._build_index.__code__  # just verify method exists

    # Spy on _build_index — replace it with a mock that counts calls
    att._build_index = MagicMock()
    original_embeddings_len = len(att._embeddings)

    new_tools = [
        {"name": "new_tool_1", "description": "Does something new", "schema": {}},
        {"name": "new_tool_2", "description": "Does another thing", "schema": {}},
    ]
    att.add_tools(new_tools)

    # CRITICAL assertion: _build_index was NOT called (the old behavior).
    att._build_index.assert_not_called()

    # The index grew by the new tools' embeddings
    assert len(att._embeddings) == original_embeddings_len + 2
    assert len(att.tools) == 5


def test_add_tools_uses_index_add_not_rebuild(fake_deps, sample_tools):
    """The FAISS index's .add() method should be called exactly once
    with only the new embeddings, not rebuilt from scratch."""
    att = ta.ToolAttention(sample_tools, verbose=False)

    # Track .add() calls on the existing index
    original_index = att._index
    add_calls_before = len(original_index.added_embeddings)

    new_tools = [{"name": "extra", "description": "extra tool", "schema": {}}]
    att.add_tools(new_tools)

    # Exactly ONE .add() call happened (for the new tool), not a rebuild
    # (a rebuild would create a new index object and not call .add() on
    # the old one at all).
    assert len(att._index.added_embeddings) == add_calls_before + 1
    assert att._index is original_index  # same index object, not replaced


def test_add_tools_extends_tools_list(fake_deps, sample_tools):
    """After add_tools, the tools list contains both old and new."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    att.add_tools([{"name": "new", "description": "new", "schema": {}}])
    names = [t["name"] for t in att.tools]
    assert "search_web" in names
    assert "calculator" in names
    assert "new" in names


def test_add_tools_preserves_search(fake_deps, sample_tools):
    """After add_tools, select() still works — the index is valid."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    att.add_tools([{"name": "new_tool", "description": "new thing", "schema": {}}])
    # select() should not raise
    result = att.select("search", k=2)
    assert isinstance(result, list)
    assert len(result) <= 2


def test_add_tools_raises_if_index_not_built(monkeypatch, sample_tools):
    """If _build_index failed at __init__ (missing deps), add_tools
    raises RuntimeError instead of silently failing."""
    att = ta.ToolAttention.__new__(ta.ToolAttention)
    att.tools = sample_tools
    att.verbose = False
    att._index = None
    att._model = None
    att._embeddings = None

    with pytest.raises(RuntimeError, match="Index not built"):
        att.add_tools([{"name": "x", "description": "y", "schema": {}}])


# ---------------------------------------------------------------------------
# Tests — select (existing behavior, now with coverage)
# ---------------------------------------------------------------------------

def test_select_returns_list_of_tools(fake_deps, sample_tools, records):
    """select() returns a list of tool dicts."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    result = att.select("search the web", k=2)
    assert isinstance(result, list)
    assert len(result) <= 2
    for t in result:
        assert "name" in t
        assert "description" in t


def test_select_saves_trace_with_kind_tool(fake_deps, sample_tools, records):
    """select() saves a trace with kind='tool', attributed to the
    enclosing agent (if any). Matches the anti-phantom-agent contract."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    att.select("search", k=2)
    assert len(records) == 1
    row = records[0]
    assert row["kind"] == "tool"
    assert row["function"] == "tool_attention.select"


def test_select_k_clamped_to_available_tools(fake_deps, sample_tools, records):
    """select(k=10) with only 3 tools returns at most 3, not error."""
    att = ta.ToolAttention(sample_tools, verbose=False)
    result = att.select("anything", k=10)
    assert len(result) <= len(sample_tools)
