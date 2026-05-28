import type { Transform } from 'node:stream';
import { ollamaAdapter } from '../adapters/ollama';

export interface Adapter {
  path: string;
  translateRequest(body: Record<string, unknown>): Record<string, unknown>;
  translateResponse(body: Record<string, unknown>): Record<string, unknown>;
  createStreamTranslator(): Transform;
}

export interface Provider {
  name: string;
  baseUrl: string;
  adapter?: Adapter;
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
};

export const ollama: Provider = {
  name: 'ollama',
  baseUrl: (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
  adapter: ollamaAdapter,
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

