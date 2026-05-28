import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, it, expect } from 'vitest';
import { translateRequest, translateResponse, createStreamTranslator } from './ollama';

// ── helpers ──────────────────────────────────────────────────────────────────

async function translate(input: string | string[]): Promise<string> {
  const chunks = (Array.isArray(input) ? input : [input]).map((s) => Buffer.from(s));
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    createStreamTranslator(),
    new Writable({ write(c, _, cb) { out.push(Buffer.from(c)); cb(); } })
  );
  return Buffer.concat(out).toString('utf8');
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function ollamaChunk(delta: Record<string, unknown>, finishReason: string | null = null, id = 'chatcmpl-1', model = 'devstral:latest'): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 1000000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

// ── translateRequest ──────────────────────────────────────────────────────────

describe('translateRequest', () => {
  it('strips the ollama/ prefix from the model name', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    expect(result.model).toBe('llama3');
  });

  it('strips the prefix case-insensitively', () => {
    const result = translateRequest({ model: 'Ollama/llama3', messages: [] });
    expect(result.model).toBe('llama3');
  });

  it('leaves a model name unchanged when there is no prefix', () => {
    const result = translateRequest({ model: 'llama3', messages: [] });
    expect(result.model).toBe('llama3');
  });

  it('preserves the messages array', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = translateRequest({ model: 'ollama/llama3', messages });
    expect(result.messages).toEqual(messages);
  });

  it('prepends a system message when system is a non-empty string', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect((result.messages as unknown[])[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect((result.messages as unknown[])[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('does not add a system message when system is absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [{ role: 'user', content: 'Hi' }] });
    expect((result.messages as unknown[]).length).toBe(1);
  });

  it('maps max_tokens when present', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], max_tokens: 512 });
    expect(result.max_tokens).toBe(512);
  });

  it('omits max_tokens when absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    expect(result.max_tokens).toBeUndefined();
  });

  it('maps stream: true', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], stream: true });
    expect(result.stream).toBe(true);
  });

  it('maps stream: false', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], stream: false });
    expect(result.stream).toBe(false);
  });

  it('flattens a content array to a single text string', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] }],
    });
    expect((result.messages as Array<{ role: string; content: string }>)[0].content).toBe('Hello world');
  });
});

// ── translateResponse ─────────────────────────────────────────────────────────

describe('translateResponse', () => {
  const ollamaResponse = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    model: 'devstral:latest',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('sets type to message', () => {
    expect(translateResponse(ollamaResponse).type).toBe('message');
  });

  it('sets role to assistant', () => {
    expect(translateResponse(ollamaResponse).role).toBe('assistant');
  });

  it('maps the response model', () => {
    expect(translateResponse(ollamaResponse).model).toBe('devstral:latest');
  });

  it('wraps content in a text content block', () => {
    const result = translateResponse(ollamaResponse);
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('maps prompt_tokens to input_tokens', () => {
    const result = translateResponse(ollamaResponse);
    expect((result.usage as { input_tokens: number }).input_tokens).toBe(10);
  });

  it('maps completion_tokens to output_tokens', () => {
    const result = translateResponse(ollamaResponse);
    expect((result.usage as { output_tokens: number }).output_tokens).toBe(5);
  });

  it('maps finish_reason stop to end_turn', () => {
    expect(translateResponse(ollamaResponse).stop_reason).toBe('end_turn');
  });

  it('maps finish_reason length to max_tokens', () => {
    const res = { ...ollamaResponse, choices: [{ ...ollamaResponse.choices[0], finish_reason: 'length' }] };
    expect(translateResponse(res).stop_reason).toBe('max_tokens');
  });

  it('passes through unknown finish reasons', () => {
    const res = { ...ollamaResponse, choices: [{ ...ollamaResponse.choices[0], finish_reason: 'tool_calls' }] };
    expect(translateResponse(res).stop_reason).toBe('tool_calls');
  });

  it('falls back to reasoning when content is empty (thinking models)', () => {
    const res = {
      ...ollamaResponse,
      choices: [{ ...ollamaResponse.choices[0], message: { role: 'assistant', content: '', reasoning: 'I think...' } }],
    };
    const result = translateResponse(res);
    expect((result.content as Array<{ text: string }>)[0].text).toBe('I think...');
  });

  it('uses content over reasoning when both are present', () => {
    const res = {
      ...ollamaResponse,
      choices: [{ ...ollamaResponse.choices[0], message: { role: 'assistant', content: 'Hello!', reasoning: 'I think...' } }],
    };
    expect((translateResponse(res).content as Array<{ text: string }>)[0].text).toBe('Hello!');
  });
});

// ── createStreamTranslator ────────────────────────────────────────────────────

describe('createStreamTranslator', () => {
  describe('message_start and content_block_start', () => {
    it('emits message_start on the first chunk with a role delta', async () => {
      const out = await translate(ollamaChunk({ role: 'assistant', content: '' }));
      expect(out).toContain('event: message_start');
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('message_start'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.type).toBe('message_start');
      expect(data.message.role).toBe('assistant');
    });

    it('emits content_block_start after message_start', async () => {
      const out = await translate(ollamaChunk({ role: 'assistant', content: '' }));
      expect(out).toContain('event: content_block_start');
    });

    it('emits message_start only once across multiple chunks', async () => {
      const chunks = [
        ollamaChunk({ role: 'assistant', content: 'Hello' }),
        ollamaChunk({ content: ' world' }),
      ];
      const out = await translate(chunks);
      const count = (out.match(/event: message_start/g) ?? []).length;
      expect(count).toBe(1);
    });
  });

  describe('content_block_delta', () => {
    it('emits content_block_delta for a chunk with non-empty content', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '' }),
        ollamaChunk({ content: 'Hi' }),
      ]);
      expect(out).toContain('event: content_block_delta');
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('text_delta'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.delta.text).toBe('Hi');
    });

    it('does not emit content_block_delta when both content and reasoning are empty', async () => {
      const out = await translate(ollamaChunk({ role: 'assistant', content: '' }));
      expect(out).not.toContain('content_block_delta');
    });

    it('falls back to reasoning when content is empty (thinking models)', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '', reasoning: 'deep thought' }),
      ]);
      expect(out).toContain('content_block_delta');
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('text_delta'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.delta.text).toBe('deep thought');
    });

    it('uses content over reasoning when both are present', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: 'final answer', reasoning: 'thinking...' }),
      ]);
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('text_delta'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.delta.text).toBe('final answer');
    });

    it('emits content from a first chunk that has both role and content', async () => {
      const out = await translate(ollamaChunk({ role: 'assistant', content: 'Hi' }));
      expect(out).toContain('event: content_block_delta');
    });
  });

  describe('stream termination', () => {
    it('emits content_block_stop on a chunk with finish_reason', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '' }),
        ollamaChunk({ content: '' }, 'stop'),
      ]);
      expect(out).toContain('event: content_block_stop');
    });

    it('emits message_delta with stop_reason end_turn when finish_reason is stop', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '' }),
        ollamaChunk({ content: '' }, 'stop'),
      ]);
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('message_delta'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.delta.stop_reason).toBe('end_turn');
    });

    it('emits message_delta with stop_reason max_tokens when finish_reason is length', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '' }),
        ollamaChunk({ content: '' }, 'length'),
      ]);
      const dataLine = out.split('\n').find((l) => l.startsWith('data:') && l.includes('message_delta'));
      const data = JSON.parse(dataLine!.slice(5));
      expect(data.delta.stop_reason).toBe('max_tokens');
    });

    it('emits message_stop after message_delta', async () => {
      const out = await translate([
        ollamaChunk({ role: 'assistant', content: '' }),
        ollamaChunk({ content: '' }, 'stop'),
      ]);
      expect(out).toContain('event: message_stop');
      const stopIdx = out.indexOf('event: message_stop');
      const deltaIdx = out.indexOf('event: message_delta');
      expect(stopIdx).toBeGreaterThan(deltaIdx);
    });

    it('ignores the [DONE] line', async () => {
      const out = await translate('data: [DONE]\n\n');
      expect(out).toBe('');
    });
  });

  describe('chunked delivery', () => {
    it('reassembles an event split across two chunks', async () => {
      const full = ollamaChunk({ role: 'assistant', content: 'Hi' });
      const mid = Math.floor(full.length / 2);
      const out = await translate([full.slice(0, mid), full.slice(mid)]);
      expect(out).toContain('event: message_start');
    });
  });

  describe('SseCapture compatibility', () => {
    it('emits output parseable by SseCapture', async () => {
      const { pipeline: pip } = await import('node:stream/promises');
      const { SseCapture } = await import('../telemetry/sse-capture');
      const chunks = [
        ollamaChunk({ role: 'assistant', content: '' }, null, 'chatcmpl-1', 'devstral:latest'),
        ollamaChunk({ content: 'Hi' }),
        ollamaChunk({ content: '' }, 'stop'),
      ];
      let attrs = {};
      const capture = new SseCapture((a) => { attrs = a; });
      const out: Buffer[] = [];
      await pip(
        Readable.from(chunks.map((s) => Buffer.from(s))),
        createStreamTranslator(),
        capture,
        new Writable({ write(c, _, cb) { out.push(Buffer.from(c)); cb(); } })
      );
      expect((attrs as Record<string, unknown>)['gen_ai.response.model']).toBe('devstral:latest');
      expect((attrs as Record<string, unknown>)['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    });
  });
});
