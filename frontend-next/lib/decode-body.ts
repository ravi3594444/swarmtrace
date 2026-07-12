/**
 * Generic request-body gzip decoding, shared across every POST route that
 * accepts `Content-Encoding: gzip` (currently /api/ingest; /api/events as
 * of audit finding #6).
 *
 * Originally lived only in lib/validate-ingest.ts (ingest-only), which is
 * why the function used to be named `decodeIngestBody`. Extracted here so
 * it's not misleadingly named for a route it didn't originally serve.
 * lib/validate-ingest.ts re-exports the old name for backward compat with
 * existing callers/tests.
 */

/**
 * Decode raw request body bytes into a JSON string, inflating gzip when
 * the client sent `Content-Encoding: gzip`.
 *
 * Edge/serverless runtimes do NOT auto-decompress request bodies (only
 * fetch *response* bodies are auto-decompressed), so callers must inflate
 * explicitly. Uses the web-standard DecompressionStream, available in the
 * Vercel Edge runtime and Node 18+.
 *
 * @param bodyBytes        Raw (possibly gzip-compressed) request body.
 * @param contentEncoding  The request's `Content-Encoding` header value.
 * @param maxDecompressedBytes  Bound on the INFLATED size. gzip can expand
 *   the wire size by ~1000x, so a small malicious payload could balloon
 *   after inflation — callers should pass a bound sized to their route's
 *   legitimate max payload, not just trust the compressed-size cap.
 *
 * Throws on invalid gzip data or when the inflated size exceeds
 * `maxDecompressedBytes` — callers map any throw to a 400.
 */
export async function decodeGzipBody(
  bodyBytes: ArrayBuffer,
  contentEncoding: string | null,
  maxDecompressedBytes: number,
): Promise<string> {
  if (contentEncoding?.toLowerCase().trim() !== 'gzip') {
    return new TextDecoder().decode(bodyBytes)
  }
  const stream = new Response(bodyBytes).body!.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxDecompressedBytes) {
      reader.cancel().catch(() => {})
      throw new Error('Decompressed payload too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(out)
}
