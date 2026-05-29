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

  it('passes temperature through', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], temperature: 0.7 });
    expect(result.temperature).toBe(0.7);
  });

  it('passes top_p through', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], top_p: 0.9 });
    expect(result.top_p).toBe(0.9);
  });

  it('maps stop_sequences to stop', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], stop_sequences: ['\n', 'END'] });
    expect(result.stop).toEqual(['\n', 'END']);
  });

  it('omits stop when stop_sequences is absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    expect(result.stop).toBeUndefined();
  });

  it('injects /no_think into system message when thinking is disabled', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], thinking: { type: 'disabled' } });
    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: '/no_think' });
  });

  it('prepends /no_think to existing system message when thinking is disabled', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], system: 'Be concise.', thinking: { type: 'disabled' } });
    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: '/no_think\nBe concise.' });
  });

  it('does not inject /no_think when thinking is enabled', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], thinking: { type: 'enabled', budget_tokens: 5000 } });
    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs.find((m) => m.role === 'system')).toBeUndefined();
  });

  it('does not inject /no_think when thinking is absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    const msgs = result.messages as Array<{ role: string; content: string }>;
    expect(msgs.find((m) => m.role === 'system')).toBeUndefined();
  });

  it('does not set think field on the result', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], thinking: { type: 'disabled' } });
    expect(result.think).toBeUndefined();
  });

  it('translates tools array to OpenAI function format', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [],
      tools: [{
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
    });
    expect(result.tools).toEqual([{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }]);
  });

  it('omits tools when absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    expect(result.tools).toBeUndefined();
  });

  it('maps tool_choice auto', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], tool_choice: { type: 'auto' } });
    expect(result.tool_choice).toBe('auto');
  });

  it('maps tool_choice any to required', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], tool_choice: { type: 'any' } });
    expect(result.tool_choice).toBe('required');
  });

  it('maps tool_choice specific tool', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [], tool_choice: { type: 'tool', name: 'get_weather' } });
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('omits tool_choice when absent', () => {
    const result = translateRequest({ model: 'ollama/llama3', messages: [] });
    expect(result.tool_choice).toBeUndefined();
  });

  it('translates assistant tool_use content blocks to tool_calls', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBeNull();
    expect(msgs[0].tool_calls).toEqual([{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: JSON.stringify({ city: 'NYC' }) },
    }]);
  });

  it('keeps text alongside tool_use in assistant message', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
        ],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe('Let me check.');
    expect(msgs[0].tool_calls).toHaveLength(1);
  });

  it('translates tool_result user content to role:tool messages', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny, 72F' }],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'Sunny, 72F' });
  });

  it('emits separate user message for non-tool-result content alongside tool_result', () => {
    const result = translateRequest({
      model: 'ollama/llama3',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' },
          { type: 'text', text: 'Thanks!' },
        ],
      }],
    });
    const msgs = result.messages as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(toolMsg).toBeDefined();
    expect(userMsg?.content).toBe('Thanks!');
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
    const res = { ...ollamaResponse, choices: [{ ...ollamaResponse.choices[0], finish_reason: 'content_filter' }] };
    expect(translateResponse(res).stop_reason).toBe('content_filter');
  });

  it('maps finish_reason tool_calls to tool_use', () => {
    const res = { ...ollamaResponse, choices: [{ ...ollamaResponse.choices[0], finish_reason: 'tool_calls' }] };
    expect(translateResponse(res).stop_reason).toBe('tool_use');
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

  it('translates tool_calls to tool_use content blocks', () => {
    const res = {
      ...ollamaResponse,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const result = translateResponse(res);
    expect(result.stop_reason).toBe('tool_use');
    expect(result.content).toEqual([{
      type: 'tool_use',
      id: 'call_1',
      name: 'get_weather',
      input: { city: 'NYC' },
    }]);
  });

  it('includes text block before tool_use when content is non-empty', () => {
    const res = {
      ...ollamaResponse,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const content = translateResponse(res).content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(content[1].type).toBe('tool_use');
  });

  it('handles multiple tool_calls', () => {
    const res = {
      ...ollamaResponse,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'fn1', arguments: '{"a":1}' } },
            { id: 'c2', type: 'function', function: { name: 'fn2', arguments: '{"b":2}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const content = translateResponse(res).content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0].name).toBe('fn1');
    expect(content[1].name).toBe('fn2');
  });
});

// ── createStreamTranslator — tool calls ──────────────────────────────────────

describe('createStreamTranslator — tool calls', () => {
  function toolChunk(
    toolCalls: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>,
    finishReason: string | null = null,
    id = 'chatcmpl-1',
  ): string {
    return `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1000000,
      model: 'qwen3:latest',
      choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finishReason }],
    })}\n\n`;
  }

  it('emits content_block_start for the first delta of a tool call', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      toolChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }]),
    ]);
    expect(out).toContain('event: content_block_start');
    const lines = out.split('\n');
    const dataLine = lines.find((l) => l.startsWith('data:') && l.includes('tool_use'));
    const data = JSON.parse(dataLine!.slice(5));
    expect(data.type).toBe('content_block_start');
    expect(data.content_block.type).toBe('tool_use');
    expect(data.content_block.name).toBe('get_weather');
    expect(data.content_block.id).toBe('call_1');
  });

  it('does not re-emit content_block_start for subsequent argument deltas of the same tool', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      toolChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'fn', arguments: '' } }]),
      toolChunk([{ index: 0, function: { arguments: '{"a":' } }]),
      toolChunk([{ index: 0, function: { arguments: '1}' } }]),
    ]);
    const startCount = (out.match(/event: content_block_start/g) ?? []).length;
    expect(startCount).toBe(2); // text block (index 0) + one tool block
  });

  it('emits content_block_delta with input_json_delta for argument fragments', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      toolChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'fn', arguments: '' } }]),
      toolChunk([{ index: 0, function: { arguments: '{"city":"NYC"}' } }]),
    ]);
    const lines = out.split('\n');
    const dataLine = lines.find((l) => l.startsWith('data:') && l.includes('input_json_delta'));
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.slice(5));
    expect(data.delta.type).toBe('input_json_delta');
    expect(data.delta.partial_json).toBe('{"city":"NYC"}');
  });

  it('emits content_block_stop and message_delta stop_reason tool_use on finish_reason tool_calls', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      toolChunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'fn', arguments: '{}' } }]),
      toolChunk([], 'tool_calls'),
    ]);
    expect(out).toContain('event: content_block_stop');
    const lines = out.split('\n');
    const deltaLine = lines.find((l) => l.startsWith('data:') && l.includes('message_delta'));
    const data = JSON.parse(deltaLine!.slice(5));
    expect(data.delta.stop_reason).toBe('tool_use');
  });

  it('assigns sequential block indices to multiple tools', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      toolChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'fn1', arguments: '' } }]),
      toolChunk([{ index: 1, id: 'c2', type: 'function', function: { name: 'fn2', arguments: '' } }]),
      toolChunk([], 'tool_calls'),
    ]);
    const startEvents = [...out.matchAll(/event: content_block_start/g)];
    expect(startEvents).toHaveLength(3); // text block (index 0) + 2 tool blocks
    // block indices should be 1 and 2 (0 is text)
    const dataLines = out.split('\n').filter((l) => l.startsWith('data:') && l.includes('content_block_start') && l.includes('tool_use'));
    const indices = dataLines.map((l) => JSON.parse(l.slice(5)).index);
    expect(indices).toEqual([1, 2]);
  });

  it('text block (index 0) is emitted before tool blocks', async () => {
    const out = await translate([
      ollamaChunk({ role: 'assistant', content: '' }),
      ollamaChunk({ content: 'Let me check.' }),
      toolChunk([{ index: 0, id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }]),
      toolChunk([], 'tool_calls'),
    ]);
    const textIdx = out.indexOf('event: content_block_start\ndata:');
    // text block start comes before tool block start
    const blockStarts = [...out.matchAll(/event: content_block_start/g)].map((m) => m.index);
    expect(blockStarts.length).toBeGreaterThanOrEqual(2);
    // first content_block_start is for text (index 0)
    const firstData = out.slice(blockStarts[0]!).split('\n\n')[0];
    const parsed = JSON.parse(firstData.split('\n').find((l) => l.startsWith('data:'))!.slice(5));
    expect(parsed.index).toBe(0);
    void textIdx; // used above
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
