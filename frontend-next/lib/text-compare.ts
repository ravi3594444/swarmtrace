/**
 * Deterministic, dependency-free text similarity + diff used by the dashboard
 * Compare view. This mirrors the intent of the CLI `regression.compare()`
 * (spotting when a new prompt/version drifts from a baseline) but runs entirely
 * client-side so it needs no LLM key — the score is a Sørensen–Dice coefficient
 * over word bigrams, which is stable and explainable.
 */

function wordBigrams(text: string): Map<string, number> {
  const words = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const grams = new Map<string, number>()
  if (words.length === 0) return grams
  if (words.length === 1) {
    grams.set(words[0], 1)
    return grams
  }
  for (let i = 0; i < words.length - 1; i++) {
    const g = `${words[i]} ${words[i + 1]}`
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  return grams
}

/**
 * Sørensen–Dice similarity over word bigrams. Returns 0.0–1.0
 * (1.0 = identical text, 0.0 = no shared bigrams). Two empty strings are
 * treated as identical.
 */
export function similarity(a: string, b: string): number {
  const ta = a.trim()
  const tb = b.trim()
  if (ta === tb) return 1.0
  if (!ta || !tb) return 0.0

  const ga = wordBigrams(ta)
  const gb = wordBigrams(tb)
  let overlap = 0
  let sizeA = 0
  let sizeB = 0
  for (const n of ga.values()) sizeA += n
  for (const n of gb.values()) sizeB += n
  for (const [gram, countA] of ga) {
    const countB = gb.get(gram)
    if (countB) overlap += Math.min(countA, countB)
  }
  if (sizeA + sizeB === 0) return 1.0
  return (2 * overlap) / (sizeA + sizeB)
}

export type DiffLine = { type: 'same' | 'added' | 'removed'; text: string }

/**
 * Minimal line-level diff (LCS-based) for side-by-side output comparison.
 * Returns a flat list of lines tagged same/added/removed.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = la.length
  const m = lb.length
  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      out.push({ type: 'same', text: la[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'removed', text: la[i] })
      i++
    } else {
      out.push({ type: 'added', text: lb[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'removed', text: la[i++] })
  while (j < m) out.push({ type: 'added', text: lb[j++] })
  return out
}
