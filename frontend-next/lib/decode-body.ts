/**
 * Decode a request body to a JSON string, inflating gzip when
 * `Content-Encoding: gzip` is set (runtimes don't do this for request
 * bodies). Shared by /api/ingest and /api/events.
 *
 * `maxDecompressedBytes` bounds the inflated size, since gzip can expand
 * ~1000x. Throws on invalid gzip or when the bound is exceeded; callers map
 * that to a 400.
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
