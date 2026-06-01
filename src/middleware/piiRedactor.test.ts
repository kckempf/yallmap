import { describe, it, expect } from 'vitest';
import { piiRedactor } from './piiRedactor';
import type { MiddlewareContext } from './types';

const OK = new Response('ok', { status: 200 });
const next = async () => OK;

function makeCtx(body: Record<string, unknown>): MiddlewareContext {
  return {
    requestId: 'test',
    model: 'claude-sonnet-4-6',
    isStreaming: false,
    maxTokens: undefined,
    body,
    clientHeaders: {},
  };
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

describe('piiRedactor', () => {
  it('is a no-op when body has no messages', async () => {
    const redactor = piiRedactor([SSN]);
    const ctx = makeCtx({ model: 'claude-sonnet-4-6' });
    await redactor(ctx, next);
    expect(ctx.body).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('redacts pattern in string content', async () => {
    const redactor = piiRedactor([SSN]);
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'My SSN is 123-45-6789 please help' }],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe('My SSN is [REDACTED] please help');
  });

  it('redacts pattern in text blocks', async () => {
    const redactor = piiRedactor([SSN]);
    const ctx = makeCtx({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'SSN: 123-45-6789' }],
        },
      ],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: Array<{ type: string; text: string }> }>;
    expect(msgs[0].content[0].text).toBe('SSN: [REDACTED]');
  });

  it('leaves tool_use blocks unchanged', async () => {
    const redactor = piiRedactor([SSN]);
    const toolBlock = { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { ssn: '123-45-6789' } };
    const ctx = makeCtx({
      messages: [{ role: 'assistant', content: [toolBlock] }],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: unknown[] }>;
    expect(msgs[0].content[0]).toEqual(toolBlock);
  });

  it('leaves tool_result blocks unchanged', async () => {
    const redactor = piiRedactor([SSN]);
    const resultBlock = { type: 'tool_result', tool_use_id: 'tu_1', content: 'ssn: 123-45-6789' };
    const ctx = makeCtx({
      messages: [{ role: 'user', content: [resultBlock] }],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: unknown[] }>;
    expect(msgs[0].content[0]).toEqual(resultBlock);
  });

  it('applies multiple patterns', async () => {
    const EMAIL = /\b[\w.+-]+@[\w-]+\.\w{2,}\b/g;
    const redactor = piiRedactor([SSN, EMAIL]);
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'SSN 123-45-6789 email user@example.com' }],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe('SSN [REDACTED] email [REDACTED]');
  });

  it('accepts a custom replacement string', async () => {
    const redactor = piiRedactor([SSN], '***');
    const ctx = makeCtx({
      messages: [{ role: 'user', content: 'ssn: 123-45-6789' }],
    });
    await redactor(ctx, next);
    const msgs = ctx.body.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe('ssn: ***');
  });

  it('calls next() and returns its response', async () => {
    const redactor = piiRedactor([SSN]);
    const ctx = makeCtx({ messages: [] });
    const res = await redactor(ctx, next);
    expect(res.status).toBe(200);
  });
});
