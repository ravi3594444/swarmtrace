import os
import json
import numpy as np
from tracely.storage import save_trace
import uuid
from datetime import datetime
import time

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
                print(f"[ToolAttention] Indexed {len(self.tools)} tools | Full schema: ~{total_tokens} tokens")

        except ImportError as e:
            print(f"[ToolAttention] Missing dependency: {e}")
            print("[ToolAttention] Run: pip install sentence-transformers faiss-cpu")
            self._index = None

    def select(self, query: str, k: int = 3) -> list:
        """
        ISO Scoring — select top-k tools by intent-schema overlap.
        Returns only the relevant tools with full schemas.
        """
        if self._index is None:
            return self.tools[:k]

        import faiss

        start = time.time()

        # Embed the query
        query_vec = self._model.encode([query], convert_to_numpy=True).astype(np.float32)

        # Search FAISS index
        actual_k = min(k, len(self.tools))
        distances, indices = self._index.search(query_vec, actual_k)

        selected = [self.tools[i] for i in indices[0]]

        # Calculate token savings
        full_tokens = sum(len(json.dumps(t.get("schema", {}))) // 4 for t in self.tools)
        active_tokens = sum(len(json.dumps(t.get("schema", {}))) // 4 for t in selected)
        savings_pct = round((1 - active_tokens / max(full_tokens, 1)) * 100, 1)
        latency = round(time.time() - start, 4)

        if self.verbose:
            print(f"[ToolAttention] Query: {query[:50]}")
            print(f"[ToolAttention] Selected {len(selected)}/{len(self.tools)} tools in {latency}s")
            print(f"[ToolAttention] Tokens: {full_tokens} → {active_tokens} ({savings_pct}% reduction)")
            for t in selected:
                print(f"[ToolAttention]   ✓ {t['name']}")

        # Save to swarmtrace
        save_trace(
            str(uuid.uuid4())[:8],  # id_
            None,                    # parent_id
            "tool_attention.select", # function
            query[:200],             # args
            str([t["name"] for t in selected]),  # output
            latency,                 # latency_sec
            None,                    # error
            datetime.utcnow().isoformat(),  # timestamp
            full_tokens,             # input_tokens
            active_tokens,           # output_tokens
            round((full_tokens - active_tokens) * 0.80 / 1_000_000, 8)  # cost_usd
        )

        return selected

    def summary_pool(self) -> str:
        """Phase 1 — compact tool list for context (cacheable)"""
        lines = [f"- {t['name']}: {t['description']}" for t in self.tools]
        return "Available tools:\n" + "\n".join(lines)
