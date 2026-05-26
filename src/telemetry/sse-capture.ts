import { Transform, TransformCallback } from 'node:stream';

// Subset of OTel SpanAttributes we'll populate from the SSE stream
export type GenAiAttrs = {
  'gen_ai.response.model'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.response.finish_reasons'?: string[];
};

// Transform stream that passes every byte through untouched while
// parsing Anthropic SSE events to extract gen_ai.* telemetry attributes.
// onComplete is called exactly once when the stream ends.
export class SseCapture extends Transform {
  private readonly onComplete: (attrs: GenAiAttrs) => void;
  private pending = '';
  private attrs: GenAiAttrs = {};

  constructor(onComplete: (attrs: GenAiAttrs) => void) {
    super();
    this.onComplete = onComplete;
  }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    // Normalize \r\n to \n for parsing only — original bytes are pushed through untouched
    this.pending += chunk.toString('utf8').replace(/\r\n/g, '\n');
    this.drainEvents();
    this.push(chunk); // pass through verbatim
    cb();
  }

  _flush(cb: TransformCallback): void {
    this.onComplete(this.attrs);
    cb();
  }

  private drainEvents(): void {
    // SSE events are separated by blank lines (\n\n)
    let boundary: number;
    while ((boundary = this.pending.indexOf('\n\n')) !== -1) {
      const block = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 2);
      this.parseBlock(block);
    }
  }

  private parseBlock(block: string): void {
    let dataLine = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine || dataLine === '[DONE]') return;

    try {
      const event = JSON.parse(dataLine) as Record<string, unknown>;
      this.applyEvent(event);
    } catch {
      // malformed data line — ignore, keep forwarding
    }
  }

  private applyEvent(event: Record<string, unknown>): void {
    if (event.type === 'message_start') {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.model) this.attrs['gen_ai.response.model'] = msg.model as string;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (typeof usage?.input_tokens === 'number') {
        this.attrs['gen_ai.usage.input_tokens'] = usage.input_tokens;
      }
    } else if (event.type === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (typeof usage?.output_tokens === 'number') {
        this.attrs['gen_ai.usage.output_tokens'] = usage.output_tokens;
      }
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === 'string') {
        this.attrs['gen_ai.response.finish_reasons'] = [delta.stop_reason];
      }
    }
  }
}
