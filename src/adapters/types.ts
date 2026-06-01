import type { Transform } from 'node:stream';

export interface ProviderAdapter {
  /** Upstream path to call (e.g. '/v1/messages', '/v1/chat/completions') */
  readonly path: string;

  /** Translate Anthropic request body → provider-specific request body */
  translateRequest(body: Record<string, unknown>): Record<string, unknown>;

  /** Translate provider JSON response → Anthropic response */
  translateResponse(body: Record<string, unknown>): Record<string, unknown>;

  /** Create a Transform stream that converts provider SSE → Anthropic SSE */
  createStreamTranslator(): Transform;

  /** Optional: probe whether this provider is currently reachable */
  isAvailable?(): Promise<boolean>;
}
