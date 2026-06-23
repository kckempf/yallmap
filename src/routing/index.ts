import { anthropicAdapter, ollamaAdapter, type ProviderAdapter } from '../adapters';

export type { ProviderAdapter };

export interface Provider {
  name: string;
  baseUrl: string;
  adapter: ProviderAdapter;
  /** Override the model name sent to this provider (e.g. map claude-haiku-4-5 → qwen3:8b) */
  modelOverride?: string;
  /**
   * Maximum time (ms) to wait for response headers from this upstream.
   * Overridden by UPSTREAM_HEADERS_TIMEOUT_MS env var if set. Defaults to
   * 30s when neither is provided. Set higher (e.g. 300_000) for local model
   * runtimes where cold-load can take 15-30s before any byte is sent.
   */
  headersTimeoutMs?: number;
  /** Maximum time (ms) to wait for response body completion. Same precedence as headersTimeoutMs. */
  bodyTimeoutMs?: number;
}

export interface RequestContext {
  model: string;
  stream: boolean;
}

export type Rule = (ctx: RequestContext) => Provider[] | null;
export type Router = (ctx: RequestContext) => Provider[];

export const anthropic: Provider = {
  name: 'anthropic',
  baseUrl: (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
  adapter: anthropicAdapter,
};

export const ollama: Provider = {
  name: 'ollama',
  baseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
  adapter: ollamaAdapter,
  // Local models can take 15-30s to cold-load before first byte; the default
  // 30s headers timeout fires before Ollama responds and the chain falls back
  // to the cloud unintentionally. 5 minutes is generous for any practical case.
  headersTimeoutMs: 300_000,
};

export function chain(...providers: Provider[]): Provider[] {
  return providers;
}

export function whenModel(pattern: string | RegExp, provider: Provider | Provider[]): Rule {
  return (ctx) => {
    const matches = typeof pattern === 'string' ? ctx.model === pattern : pattern.test(ctx.model);
    if (!matches) return null;
    return Array.isArray(provider) ? provider : [provider];
  };
}

export function firstMatch(rules: Rule[], fallback: Provider = anthropic): Router {
  return (ctx) => {
    for (const rule of rules) {
      const result = rule(ctx);
      if (result !== null) return result;
    }
    return [fallback];
  };
}
