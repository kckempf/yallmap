import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { anthropicAdapter } from './anthropic';

describe('anthropicAdapter', () => {
  it('has path /v1/messages', () => {
    expect(anthropicAdapter.path).toBe('/v1/messages');
  });

  it('translateRequest is identity', () => {
    const body = { model: 'claude-sonnet-4-6', messages: [], max_tokens: 1024 };
    expect(anthropicAdapter.translateRequest(body)).toBe(body);
  });

  it('translateResponse is identity', () => {
    const body = { id: 'msg_1', type: 'message', content: [] };
    expect(anthropicAdapter.translateResponse(body)).toBe(body);
  });

  it('createStreamTranslator returns a PassThrough', () => {
    expect(anthropicAdapter.createStreamTranslator()).toBeInstanceOf(PassThrough);
  });
});
