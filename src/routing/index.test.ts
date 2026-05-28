import { describe, it, expect } from 'vitest';
import { firstMatch, whenModel, chain, type Provider, type RequestContext } from './index';

const ANTHROPIC: Provider = { name: 'anthropic', baseUrl: 'https://api.anthropic.com' };
const OLLAMA: Provider = { name: 'ollama', baseUrl: 'http://localhost:11434' };
const BACKUP: Provider = { name: 'backup', baseUrl: 'http://backup:11434' };

const ctx = (model: string, stream = false): RequestContext => ({ model, stream });

describe('whenModel', () => {
  it('matches an exact string model name', () => {
    const rule = whenModel('claude-sonnet-4-6', ANTHROPIC);
    expect(rule(ctx('claude-sonnet-4-6'))).toEqual([ANTHROPIC]);
  });

  it('returns null when model does not match string', () => {
    const rule = whenModel('claude-sonnet-4-6', ANTHROPIC);
    expect(rule(ctx('gpt-4o'))).toBeNull();
  });

  it('matches model name with a regex', () => {
    const rule = whenModel(/^ollama\//i, OLLAMA);
    expect(rule(ctx('ollama/llama3'))).toEqual([OLLAMA]);
  });

  it('matches regex case-insensitively when flag is set', () => {
    const rule = whenModel(/^ollama\//i, OLLAMA);
    expect(rule(ctx('Ollama/llama3'))).toEqual([OLLAMA]);
  });

  it('returns null when regex does not match', () => {
    const rule = whenModel(/^ollama\//i, OLLAMA);
    expect(rule(ctx('claude-sonnet-4-6'))).toBeNull();
  });

  it('returns the specified provider object on match', () => {
    const rule = whenModel(/^ollama\//, OLLAMA);
    expect(rule(ctx('ollama/mistral'))).toEqual([OLLAMA]);
  });

  it('accepts a provider array and returns it on match', () => {
    const rule = whenModel(/^ollama\//, [OLLAMA, ANTHROPIC]);
    expect(rule(ctx('ollama/llama3'))).toEqual([OLLAMA, ANTHROPIC]);
  });

  it('returns null for a provider array when pattern does not match', () => {
    const rule = whenModel(/^ollama\//, [OLLAMA, ANTHROPIC]);
    expect(rule(ctx('claude-sonnet-4-6'))).toBeNull();
  });
});

describe('chain', () => {
  it('returns providers in order', () => {
    expect(chain(OLLAMA, ANTHROPIC)).toEqual([OLLAMA, ANTHROPIC]);
  });

  it('works with a single provider', () => {
    expect(chain(ANTHROPIC)).toEqual([ANTHROPIC]);
  });

  it('works with three providers', () => {
    expect(chain(OLLAMA, BACKUP, ANTHROPIC)).toEqual([OLLAMA, BACKUP, ANTHROPIC]);
  });

  it('integrates with whenModel to produce a fallback list', () => {
    const rule = whenModel(/^ollama\//, chain(OLLAMA, ANTHROPIC));
    expect(rule(ctx('ollama/llama3'))).toEqual([OLLAMA, ANTHROPIC]);
  });
});

describe('firstMatch', () => {
  it('returns fallback when rules array is empty', () => {
    const router = firstMatch([], ANTHROPIC);
    expect(router(ctx('any-model'))).toEqual([ANTHROPIC]);
  });

  it('returns fallback when no rules match', () => {
    const router = firstMatch([whenModel('specific-model', OLLAMA)], ANTHROPIC);
    expect(router(ctx('other-model'))).toEqual([ANTHROPIC]);
  });

  it('returns the first matching rule providers', () => {
    const router = firstMatch([whenModel(/^ollama\//, OLLAMA)], ANTHROPIC);
    expect(router(ctx('ollama/llama3'))).toEqual([OLLAMA]);
  });

  it('stops at the first matching rule and ignores later ones', () => {
    const SECOND: Provider = { name: 'second', baseUrl: 'http://second' };
    const router = firstMatch([
      whenModel(/^ollama\//, OLLAMA),
      whenModel(/^ollama\//, SECOND),
    ], ANTHROPIC);
    expect(router(ctx('ollama/llama3'))).toEqual([OLLAMA]);
  });

  it('skips non-matching rules and returns a later match', () => {
    const router = firstMatch([
      whenModel('specific', OLLAMA),
      whenModel(/^claude-/, ANTHROPIC),
    ], OLLAMA);
    expect(router(ctx('claude-sonnet-4-6'))).toEqual([ANTHROPIC]);
  });

  it('defaults to anthropic when no fallback argument is provided', () => {
    const router = firstMatch([]);
    expect(router(ctx('any-model'))[0].name).toBe('anthropic');
  });

  it('passes the full context to each rule', () => {
    const seen: RequestContext[] = [];
    const spy = (c: RequestContext) => { seen.push(c); return null; };
    const router = firstMatch([spy], ANTHROPIC);
    router(ctx('my-model', true));
    expect(seen[0]).toEqual({ model: 'my-model', stream: true });
  });

  it('returns a chain of providers when a rule matches with multiple providers', () => {
    const router = firstMatch([whenModel(/^ollama\//, chain(OLLAMA, ANTHROPIC))], ANTHROPIC);
    expect(router(ctx('ollama/llama3'))).toEqual([OLLAMA, ANTHROPIC]);
  });
});

describe('routing behaviour', () => {
  it('routes ollama/* models to the ollama provider', () => {
    const router = firstMatch([whenModel(/^ollama\//i, OLLAMA)], ANTHROPIC);
    expect(router(ctx('ollama/llama3:8b'))).toEqual([OLLAMA]);
  });

  it('routes ollama/* models case-insensitively', () => {
    const router = firstMatch([whenModel(/^ollama\//i, OLLAMA)], ANTHROPIC);
    expect(router(ctx('Ollama/mistral'))).toEqual([OLLAMA]);
  });

  it('routes claude-* models to the anthropic fallback', () => {
    const router = firstMatch([whenModel(/^ollama\//i, OLLAMA)], ANTHROPIC);
    expect(router(ctx('claude-sonnet-4-6'))).toEqual([ANTHROPIC]);
  });

  it('routes unknown models to the anthropic fallback', () => {
    const router = firstMatch([whenModel(/^ollama\//i, OLLAMA)], ANTHROPIC);
    expect(router(ctx('gpt-4o'))).toEqual([ANTHROPIC]);
  });

  it('routes ollama/* with fallback chain for high-availability', () => {
    const router = firstMatch([whenModel(/^ollama\//i, chain(OLLAMA, ANTHROPIC))], ANTHROPIC);
    const providers = router(ctx('ollama/llama3'));
    expect(providers).toEqual([OLLAMA, ANTHROPIC]);
    expect(providers[0]).toBe(OLLAMA);
    expect(providers[1]).toBe(ANTHROPIC);
  });
});
