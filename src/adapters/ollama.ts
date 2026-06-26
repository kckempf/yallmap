import { Transform } from 'node:stream';
import type { ProviderAdapter } from './types';

const path = '/v1/chat/completions';

type OAIMessage = Record<string, unknown>;

function translateMessages(body: Record<string, unknown>): OAIMessage[] {
  const messages: OAIMessage[] = [];

  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system });
  }

  if (!Array.isArray(body.messages)) return messages;

  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = typeof msg.role === 'string' ? msg.role : 'user';
    const content = msg.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      messages.push({ role, content: '' });
      continue;
    }

    // Check for tool_result blocks (user turn only) — each becomes a role:tool message
    const toolResults = content.filter((b: unknown) =>
      b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'
    );
    const otherBlocks = content.filter((b: unknown) =>
      !b || typeof b !== 'object' || (b as Record<string, unknown>).type !== 'tool_result'
    );

    for (const tr of toolResults) {
      const t = tr as Record<string, unknown>;
      const toolContent = Array.isArray(t.content)
        ? (t.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text as string)
            .join('')
        : (typeof t.content === 'string' ? t.content : '');
      messages.push({ role: 'tool', tool_call_id: t.tool_use_id, content: toolContent });
    }

    // Check for tool_use blocks (assistant turn) → tool_calls
    const toolUseBlocks = otherBlocks.filter((b: unknown) =>
      b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use'
    );
    const textBlocks = otherBlocks.filter((b: unknown) =>
      b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
    );

    if (toolUseBlocks.length > 0) {
      const textContent = textBlocks
        .map((b: unknown) => (b as Record<string, unknown>).text as string)
        .join('') || null;
      const toolCalls = toolUseBlocks.map((b: unknown) => {
        const t = b as Record<string, unknown>;
        return {
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        };
      });
      messages.push({ role, content: textContent, tool_calls: toolCalls });
    } else if (otherBlocks.length > 0) {
      // Pure text or mixed non-tool content
      const text = textBlocks
        .map((b: unknown) => (b as Record<string, unknown>).text as string)
        .join('');
      if (text || toolResults.length === 0) messages.push({ role, content: text });
    }
  }

  return messages;
}

export function translateRequest(body: Record<string, unknown>): Record<string, unknown> {
  const rawModel = typeof body.model === 'string' ? body.model : '';
  const model = rawModel.replace(/^ollama\//i, '');

  const thinking = body.thinking as { type?: string } | undefined;
  // /no_think is a model-level token that disables thinking regardless of API layer
  const effectiveBody = thinking?.type === 'disabled'
    ? { ...body, system: body.system ? `/no_think\n${body.system}` : '/no_think' }
    : body;

  const result: Record<string, unknown> = { model, messages: translateMessages(effectiveBody) };

  if (typeof body.max_tokens === 'number')   result.max_tokens = body.max_tokens;
  if (body.stream !== undefined)             result.stream = body.stream;
  // OpenAI-compatible streaming drops the usage object from the wire unless
  // the caller explicitly asks for it. Without this flag, Langfuse charts
  // and any other downstream consumer see input/output tokens of 0 on every
  // streaming Ollama span — there's no way to recover the count after the
  // fact. The non-streaming path already carries usage in the body.
  if (body.stream === true)                  result.stream_options = { include_usage: true };
  if (typeof body.temperature === 'number')  result.temperature = body.temperature;
  if (typeof body.top_p === 'number')        result.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences))    result.stop = body.stop_sequences;

  if (Array.isArray(body.tools)) {
    result.tools = (body.tools as Array<Record<string, unknown>>).map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  const tc = body.tool_choice as Record<string, unknown> | undefined;
  if (tc) {
    if (tc.type === 'auto') result.tool_choice = 'auto';
    else if (tc.type === 'any') result.tool_choice = 'required';
    else if (tc.type === 'tool') result.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  return result;
}

function mapFinishReason(finishReason: string | null): string | null {
  if (finishReason === 'stop') return 'end_turn';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'tool_calls') return 'tool_use';
  return finishReason;
}

export function translateResponse(body: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const usage = (body.usage ?? {}) as Record<string, number>;

  const contentBlocks: Array<Record<string, unknown>> = [];

  // Text content (prefer content over reasoning)
  const text = (typeof message.content === 'string' && message.content)
    ? message.content
    : (typeof message.reasoning === 'string' ? message.reasoning : '');
  if (text) contentBlocks.push({ type: 'text', text });

  // Tool calls
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tc of toolCalls) {
    const t = tc as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    let input: unknown = {};
    try { input = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}'); } catch { /* keep empty */ }
    contentBlocks.push({ type: 'tool_use', id: t.id, name: fn.name, input });
  }

  return {
    id: typeof body.id === 'string' ? body.id.replace(/^chatcmpl-/, 'msg_') : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? '',
    content: contentBlocks,
    stop_reason: mapFinishReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

export function createStreamTranslator(): Transform {
  let pending = '';
  let firstChunk = true;
  let model = '';
  // blockIndex 0 = text; tool calls start at 1
  const openToolBlocks = new Map<number, number>(); // ollamaIndex → blockIndex
  let nextBlockIndex = 1;
  let textBlockOpen = false;
  // The finish_reason chunk and the usage chunk arrive separately in
  // OpenAI-compatible streams (when stream_options.include_usage is set).
  // Accumulate both across chunks and emit the synthesised message_delta
  // exactly once — in flush() — so the downstream Anthropic-shape SSE carries
  // both the stop reason and the token counts on a single event.
  let pendingStopReason: string | null = null;
  const pendingUsage = { input_tokens: 0, output_tokens: 0 };

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      pending += chunk.toString('utf8').replace(/\r\n/g, '\n');

      const events = pending.split('\n\n');
      pending = events.pop() ?? '';

      for (const event of events) {
        // SSE spec: multiple `data:` lines in one event are joined with \n.
        const dataLines: string[] = [];
        for (const line of event.split('\n')) {
          if (line.startsWith('data:')) {
            const after = line.slice(5);
            dataLines.push(after.startsWith(' ') ? after.slice(1) : after);
          }
        }
        if (dataLines.length === 0) continue;

        const raw = dataLines.join('\n').trim();
        if (raw === '[DONE]') continue;

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (typeof parsed.model === 'string') model = parsed.model;

        // Usage may arrive on its own chunk (choices=[], usage populated)
        // AFTER the finish_reason chunk, per the OpenAI streaming spec.
        // Accumulate eagerly on any chunk that carries it so the order of
        // finish_reason vs usage chunks doesn't matter.
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage.prompt_tokens === 'number') pendingUsage.input_tokens = usage.prompt_tokens;
          if (typeof usage.completion_tokens === 'number') pendingUsage.output_tokens = usage.completion_tokens;
        }

        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        const finishReason = choice.finish_reason as string | null;

        if (firstChunk && 'role' in delta) {
          firstChunk = false;
          const msgId = typeof parsed.id === 'string'
            ? parsed.id.replace(/^chatcmpl-/, 'msg_')
            : 'msg_translated';

          this.push(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: msgId, type: 'message', role: 'assistant', content: [],
              model, stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })}\n\n`);

          this.push(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start', index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`);
          textBlockOpen = true;
        }

        const text = (typeof delta.content === 'string' && delta.content)
          ? delta.content
          : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
        if (text) {
          this.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text },
          })}\n\n`);
        }

        // Tool call deltas
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const tc of toolCalls) {
          const t = tc as Record<string, unknown>;
          const ollamaIndex = typeof t.index === 'number' ? t.index : 0;
          const fn = (t.function ?? {}) as Record<string, unknown>;

          if (!openToolBlocks.has(ollamaIndex)) {
            // First delta for this tool — close text block if open, open tool block
            if (textBlockOpen) {
              this.push(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop', index: 0,
              })}\n\n`);
              textBlockOpen = false;
            }
            const blockIndex = nextBlockIndex++;
            openToolBlocks.set(ollamaIndex, blockIndex);
            this.push(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: t.id, name: fn.name, input: {} },
            })}\n\n`);
          }

          const blockIndex = openToolBlocks.get(ollamaIndex)!;
          if (typeof fn.arguments === 'string' && fn.arguments) {
            this.push(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            })}\n\n`);
          }
        }

        if (finishReason) {
          // Close blocks immediately so any subsequent usage-only chunk
          // doesn't interleave with content events. Don't emit
          // message_delta / message_stop yet — those wait for flush, when
          // pendingUsage has had every chunk to land on.
          if (textBlockOpen) {
            this.push(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop', index: 0,
            })}\n\n`);
            textBlockOpen = false;
          }
          for (const blockIndex of openToolBlocks.values()) {
            this.push(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop', index: blockIndex,
            })}\n\n`);
          }
          openToolBlocks.clear();
          pendingStopReason = mapFinishReason(finishReason) ?? finishReason;
        }
      }

      callback();
    },

    flush(callback) {
      // Single termination path for both the happy case (finish_reason +
      // usage both arrived) and the degraded one (no finish_reason — Ollama
      // dropped the connection). In the happy case, the closes already ran
      // when finish_reason fired; the guards below no-op cleanly. In the
      // degraded case, this is where every dangling block gets closed.
      if (firstChunk) { callback(); return; }

      if (textBlockOpen) {
        this.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop', index: 0,
        })}\n\n`);
        textBlockOpen = false;
      }
      for (const blockIndex of openToolBlocks.values()) {
        this.push(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop', index: blockIndex,
        })}\n\n`);
      }
      openToolBlocks.clear();

      this.push(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: pendingStopReason ?? 'end_turn', stop_sequence: null },
        usage: { input_tokens: pendingUsage.input_tokens, output_tokens: pendingUsage.output_tokens },
      })}\n\n`);
      this.push(`event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`);

      callback();
    },
  });
}

export const ollamaAdapter: ProviderAdapter = { path, translateRequest, translateResponse, createStreamTranslator };
