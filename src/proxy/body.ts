export type BodyResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too-large'; limit: number };

export async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BodyResult> {
  if (!stream) return { ok: true, body: Buffer.alloc(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: 'too-large', limit: maxBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, body: Buffer.concat(chunks) };
}
