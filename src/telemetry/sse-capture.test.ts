import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, it, expect, vi } from 'vitest';
import { SseCapture, type GenAiAttrs } from './sse-capture';

// Pipe one or more string chunks through SseCapture, collect output and attrs
async function pipe(
  input: string | string[],
  captureContent = false,
): Promise<{ output: string; attrs: GenAiAttrs }> {
  const chunks = (Array.isArray(input) ? input : [input]).map((s) => Buffer.from(s));
  let attrs: GenAiAttrs = {};
  const capture = new SseCapture((a) => { attrs = a; }, captureContent);
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(chunks),
    capture,
    new Writable({ write(c, _, cb) { out.push(Buffer.from(c)); cb(); } })
  );
  return { output: Buffer.concat(out).toString('utf8'), attrs };
}

// Realistic Anthropic SSE fixtures
const MESSAGE_START = (model = 'claude-sonnet-4-6', inputTokens = 10) =>
  `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  })}\n\n`;

const CONTENT_DELTA = (text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

const MESSAGE_DELTA = (outputTokens = 25, stopReason = 'end_turn') =>
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`;

const PING = `event: ping\ndata: {"type":"ping"}\n\n`;
const MESSAGE_STOP = `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

describe('SseCapture', () => {
  describe('passthrough', () => {
    it('passes bytes through verbatim for a full streaming response', async () => {
      const input = MESSAGE_START() + CONTENT_DELTA('Hello') + MESSAGE_DELTA() + MESSAGE_STOP;
      const { output } = await pipe(input);
      expect(output).toBe(input);
    });

    it('passes \\r\\n bytes through unchanged without normalising to \\n', async () => {
      const input = 'event: ping\r\ndata: {"type":"ping"}\r\n\r\n';
      const { output } = await pipe(input);
      expect(output).toBe(input);
    });

    it('passes through an empty stream', async () => {
      const { output, attrs } = await pipe('');
      expect(output).toBe('');
      expect(attrs).toEqual({});
    });
  });

  describe('message_start event', () => {
    it('extracts gen_ai.response.model', async () => {
      const { attrs } = await pipe(MESSAGE_START('claude-opus-4-5'));
      expect(attrs['gen_ai.response.model']).toBe('claude-opus-4-5');
    });

    it('extracts gen_ai.usage.input_tokens', async () => {
      const { attrs } = await pipe(MESSAGE_START('claude-sonnet-4-6', 342));
      expect(attrs['gen_ai.usage.input_tokens']).toBe(342);
    });

    it('ignores input_tokens if not a number', async () => {
      const event = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 'lots' } },
      })}\n\n`;
      const { attrs } = await pipe(event);
      expect(attrs['gen_ai.usage.input_tokens']).toBeUndefined();
    });
  });

  describe('message_delta event', () => {
    it('extracts gen_ai.usage.output_tokens', async () => {
      const { attrs } = await pipe(MESSAGE_START() + MESSAGE_DELTA(99));
      expect(attrs['gen_ai.usage.output_tokens']).toBe(99);
    });

    it('extracts gen_ai.response.finish_reasons', async () => {
      const { attrs } = await pipe(MESSAGE_START() + MESSAGE_DELTA(10, 'max_tokens'));
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['max_tokens']);
    });

    it('ignores output_tokens if not a number', async () => {
      const event = `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 'many' },
      })}\n\n`;
      const { attrs } = await pipe(event);
      expect(attrs['gen_ai.usage.output_tokens']).toBeUndefined();
    });

    it('extracts gen_ai.usage.input_tokens from message_delta.usage', async () => {
      // The Ollama-adapter path puts input_tokens on message_delta because it
      // can't fit them on message_start — Ollama doesn't return prompt_tokens
      // until after the content is streamed. Anthropic native carries this on
      // message_start instead, so reading it from BOTH places is the permissive
      // path that fixes Ollama without breaking Anthropic.
      const event = `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 42, output_tokens: 7 },
      })}\n\n`;
      const { attrs } = await pipe(event);
      expect(attrs['gen_ai.usage.input_tokens']).toBe(42);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(7);
    });

    it('ignores input_tokens on message_delta if not a number', async () => {
      const event = `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 'many', output_tokens: 5 },
      })}\n\n`;
      const { attrs } = await pipe(event);
      expect(attrs['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    });
  });

  describe('full streaming response', () => {
    it('collects all attributes from a complete response', async () => {
      const input = MESSAGE_START('claude-sonnet-4-6', 343) + PING + CONTENT_DELTA('Hello!') + MESSAGE_DELTA(13, 'end_turn') + MESSAGE_STOP;
      const { attrs } = await pipe(input);
      expect(attrs).toEqual({
        'gen_ai.response.model': 'claude-sonnet-4-6',
        'gen_ai.usage.input_tokens': 343,
        'gen_ai.usage.output_tokens': 13,
        'gen_ai.response.finish_reasons': ['end_turn'],
      });
    });
  });

  describe('line ending handling', () => {
    it('parses events with \\r\\n line endings', async () => {
      const input = MESSAGE_START().replace(/\n/g, '\r\n');
      const { attrs } = await pipe(input);
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });

    it('parses events delivered in \\r\\n chunks', async () => {
      const fullStream =
        (MESSAGE_START('claude-sonnet-4-6', 50) + MESSAGE_DELTA(20)).replace(/\n/g, '\r\n');
      // Split mid-stream to simulate chunked delivery
      const mid = Math.floor(fullStream.length / 2);
      const { attrs } = await pipe([fullStream.slice(0, mid), fullStream.slice(mid)]);
      expect(attrs['gen_ai.usage.input_tokens']).toBe(50);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(20);
    });
  });

  describe('chunked delivery', () => {
    it('reassembles an event split across two chunks', async () => {
      const full = MESSAGE_START('claude-sonnet-4-6', 7);
      const mid = Math.floor(full.length / 2);
      const { attrs } = await pipe([full.slice(0, mid), full.slice(mid)]);
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
      expect(attrs['gen_ai.usage.input_tokens']).toBe(7);
    });

    it('reassembles an event split across many single-byte chunks', async () => {
      const full = MESSAGE_START('claude-haiku-4-5', 3);
      const { attrs } = await pipe([...full].map((c) => c));
      expect(attrs['gen_ai.response.model']).toBe('claude-haiku-4-5');
    });
  });

  describe('error resilience', () => {
    it('ignores a malformed JSON data line and keeps processing', async () => {
      const bad = `event: broken\ndata: {not valid json}\n\n`;
      const { attrs } = await pipe(bad + MESSAGE_START('claude-sonnet-4-6', 5));
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });

    it('ignores events with unknown type', async () => {
      const unknown = `event: something_new\ndata: {"type":"something_new","value":42}\n\n`;
      const { attrs } = await pipe(unknown + MESSAGE_START());
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });

    it('ignores a ping event', async () => {
      const { attrs } = await pipe(PING + MESSAGE_START());
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
    });
  });

  describe('SSE data continuation lines', () => {
    // Per the SSE spec, multiple `data:` lines in a single event are joined with
    // \n into the field value. Anthropic doesn't emit multi-line data today, but
    // we shouldn't silently drop or corrupt continuation lines if they arrive.
    it('joins multi-line data fields with \\n', async () => {
      // Split between top-level object members — newline between tokens is
      // valid JSON whitespace, so joining with \n must reparse fine.
      const first = '{"type":"message_start",';
      const second = '"message":{"id":"msg_x","type":"message","role":"assistant","content":[],"model":"claude-multiline","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":1}}}';
      const block = `event: message_start\ndata: ${first}\ndata: ${second}\n\n`;
      const { attrs } = await pipe(block);
      expect(attrs['gen_ai.response.model']).toBe('claude-multiline');
      expect(attrs['gen_ai.usage.input_tokens']).toBe(7);
    });

    it('output_tokens are not under-counted when message_delta arrives as continuation lines', async () => {
      const first = '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},';
      const second = '"usage":{"output_tokens":42}}';
      const block = `event: message_delta\ndata: ${first}\ndata: ${second}\n\n`;
      const { attrs } = await pipe(MESSAGE_START() + block);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(42);
      expect(attrs['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    });
  });

  describe('content capture (captureContent=true)', () => {
    it('gen_ai.completion is absent by default', async () => {
      const input = MESSAGE_START() + CONTENT_DELTA('Hello') + MESSAGE_DELTA() + MESSAGE_STOP;
      const { attrs } = await pipe(input);
      expect(attrs['gen_ai.completion']).toBeUndefined();
    });

    it('captures accumulated text as gen_ai.completion', async () => {
      const input = MESSAGE_START() + CONTENT_DELTA('Hello') + CONTENT_DELTA(', world') + MESSAGE_DELTA() + MESSAGE_STOP;
      const { attrs } = await pipe(input, true);
      const completion = JSON.parse(attrs['gen_ai.completion']!);
      expect(completion).toEqual([{ type: 'text', text: 'Hello, world' }]);
    });

    it('gen_ai.completion is absent when no text deltas arrive', async () => {
      const { attrs } = await pipe(MESSAGE_START() + MESSAGE_DELTA(), true);
      expect(attrs['gen_ai.completion']).toBeUndefined();
    });

    it('still captures all standard attrs alongside content', async () => {
      const input = MESSAGE_START('claude-sonnet-4-6', 10) + CONTENT_DELTA('Hi') + MESSAGE_DELTA(5, 'end_turn');
      const { attrs } = await pipe(input, true);
      expect(attrs['gen_ai.response.model']).toBe('claude-sonnet-4-6');
      expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
      expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
      expect(JSON.parse(attrs['gen_ai.completion']!)[0].text).toBe('Hi');
    });
  });

  describe('onComplete callback', () => {
    it('calls onComplete exactly once', async () => {
      const onComplete = vi.fn();
      const capture = new SseCapture(onComplete);
      const out: Buffer[] = [];
      await pipeline(
        Readable.from([Buffer.from(MESSAGE_START() + MESSAGE_DELTA())]),
        capture,
        new Writable({ write(c, _, cb) { out.push(c); cb(); } })
      );
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('calls onComplete with empty attrs for an empty stream', async () => {
      const onComplete = vi.fn();
      const capture = new SseCapture(onComplete);
      const out: Buffer[] = [];
      await pipeline(
        Readable.from([]),
        capture,
        new Writable({ write(c, _, cb) { out.push(c); cb(); } })
      );
      expect(onComplete).toHaveBeenCalledWith({});
    });
  });
});
