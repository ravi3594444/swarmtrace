import json
import logging
import time
import uuid
from datetime import datetime, timezone

from swarmtrace.storage import save_trace
from swarmtrace.tracer import _current_agent

_log = logging.getLogger("swarmtrace.tool_attention")


class ToolAttention:
    """
    Implements Tool Attention (ISO Scoring) from arXiv:2604.21816
    Reduces tool token overhead by up to 95% using semantic similarity.
    """

    def __init__(self, tools: list, verbose=True):
        """
        tools: list of dicts with 'name', 'description', 'schema'
        """
        self.tools = tools
        self.verbose = verbose
        self._embeddings = None
        self._model = None
        self._build_index()

    def _build_index(self):
        try:
            # Lazy-import all optional deps (numpy, sentence_transformers,
            # faiss) inside the methods that use them — NOT at module top
            # level. A top-level `import numpy` would crash `import
            # swarmtrace` for anyone who did `pip install swarmtrace`
            # (numpy is under the [tools] extra, not the base install).
            # Matches the lazy-import pattern in regression.py / scraper.py.
            import numpy as np
            from sentence_transformers import SentenceTransformer
            import faiss

            self._model = SentenceTransformer("all-MiniLM-L6-v2")

            # Phase 1 — embed tool summaries only (not full schemas)
            summaries = [f"{t['name']}: {t['description']}" for t in self.tools]
            self._embeddings = self._model.encode(summaries, convert_to_numpy=True)

            # Build FAISS index
            dim = self._embeddings.shape[1]
            self._index = faiss.IndexFlatL2(dim)
            self._index.add(self._embeddings.astype(np.float32))

            if self.verbose:
                total_tokens = sum(len(json.dumps(t.get("schema", {}))) // 4 for t in self.tools)
                _log.info("Indexed %d tools | Full schema: ~%d tokens", len(self.tools), total_tokens)

        except ImportError as e:
            raise ImportError(
                f"[ToolAttention] Missing dependency: {e}\n"
                "Install required packages before using ToolAttention:\n"
                "  pip install sentence-transformers faiss-cpu"
            ) from e

    def add_tools(self, new_tools: list):
        """Dynamically add tools and rebuild the index."""
        self.tools.extend(new_tools)
        self._build_index()

    def select(self, query: str, k: int = 3) -> list:
        """
        ISO Scoring — select top-k tools by intent-schema overlap.
        Returns only the relevant tools with full schemas.
        """
        if self._index is None:
            raise RuntimeError(
                "[ToolAttention] Index not built. "
                "Ensure sentence-transformers and faiss-cpu are installed."
            )

        start = time.time()

        # Lazy-import numpy — see _build_index() for why this is here and
        # not at module top level.
        import numpy as np

        # Embed the query
        query_vec = self._model.encode([query], convert_to_numpy=True).astype(np.float32)

        # Search FAISS index
        actual_k = min(k, len(self.tools))
        distances, indices = self._index.search(query_vec, actual_k)

        selected = [self.tools[i] for i in indices[0]]

        # Calculate token savings
        full_tokens   = sum(len(json.dumps(t.get("schema", {}))) // 4 for t in self.tools)
        active_tokens = sum(len(json.dumps(t.get("schema", {}))) // 4 for t in selected)
        savings_pct   = round((1 - active_tokens / max(full_tokens, 1)) * 100, 1)
        latency       = round(time.time() - start, 4)

        if self.verbose:
            _log.info("Query: %s", query[:50])
            _log.info("Selected %d/%d tools in %ss", len(selected), len(self.tools), latency)
            _log.info("Tokens: %d → %d (%s%% reduction)", full_tokens, active_tokens, savings_pct)
            for t in selected:
                _log.info("  ✓ %s", t['name'])

        # Save to swarmtrace — attribute to whichever @observe(kind="agent")
        # call is currently in progress (if any), tagged as a tool call so
        # it rolls into that agent's stats instead of becoming its own
        # phantom "agent" on the dashboard.
        agent_id, agent_name = _current_agent() or (None, None)
        save_trace(
            str(uuid.uuid4().hex),   # full 32-char — short IDs collision-prone at scale
            None,
            "tool_attention.select",
            query[:200],
            str([t["name"] for t in selected]),
            latency,
            None,
            datetime.now(timezone.utc).isoformat(),  # fixed: was deprecated utcnow()
            full_tokens,
            active_tokens,
            round((full_tokens - active_tokens) * 0.80 / 1_000_000, 8),
            kind="tool", agent_id=agent_id, agent_name=agent_name,
        )

        return selected

    def summary_pool(self) -> str:
        """Phase 1 — compact tool list for context (cacheable)"""
        lines = [f"- {t['name']}: {t['description']}" for t in self.tools]
        return "Available tools:\n" + "\n".join(lines)
