import { Transform } from 'node:stream';

export const path = '/v1/chat/completions';

export function translateRequest(body: Record<string, unknown>): Record<string, unknown> {
  const rawModel = typeof body.model === 'string' ? body.model : '';
  const model = rawModel.replace(/^ollama\//i, '');

  const messages: Array<{ role: string; content: string }> = [];

  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system });
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof msg.role === 'string' ? msg.role : 'user';
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
          .map((b: unknown) => (b as Record<string, unknown>).text as string)
          .join('');
      }
      messages.push({ role, content });
    }
  }

  const result: Record<string, unknown> = { model, messages };
  if (typeof body.max_tokens === 'number') result.max_tokens = body.max_tokens;
  if (body.stream !== undefined) result.stream = body.stream;
  return result;
}

export function translateResponse(body: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const text = (typeof message.content === 'string' && message.content)
    ? message.content
    : (typeof message.reasoning === 'string' ? message.reasoning : '');
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const usage = (body.usage ?? {}) as Record<string, number>;

  const stopReason =
    finishReason === 'stop' ? 'end_turn' :
    finishReason === 'length' ? 'max_tokens' :
    finishReason;

  return {
    id: typeof body.id === 'string' ? body.id.replace(/^chatcmpl-/, 'msg_') : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? '',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
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

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      pending += chunk.toString('utf8').replace(/\r\n/g, '\n');

      const events = pending.split('\n\n');
      pending = events.pop() ?? '';

      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;

        const raw = dataLine.slice(6).trim();
        if (raw === '[DONE]') continue;

        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (typeof parsed.model === 'string') model = parsed.model;

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

        if (finishReason) {
          const stopReason =
            finishReason === 'stop' ? 'end_turn' :
            finishReason === 'length' ? 'max_tokens' : finishReason;

          const usageData = (parsed.usage ?? {}) as Record<string, number>;

          this.push(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop', index: 0,
          })}\n\n`);

          this.push(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usageData.completion_tokens ?? 0 },
          })}\n\n`);

          this.push(`event: message_stop\ndata: ${JSON.stringify({
            type: 'message_stop',
          })}\n\n`);
        }
      }

      callback();
    },

    flush(callback) { callback(); },
  });
}

export const ollamaAdapter = { path, translateRequest, translateResponse, createStreamTranslator };
