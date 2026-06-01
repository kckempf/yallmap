import type { MiddlewareFn } from './types';

export function piiRedactor(patterns: RegExp[], replacement = '[REDACTED]'): MiddlewareFn {
  const redactText = (s: string) => patterns.reduce((t, p) => t.replace(p, replacement), s);

  const redactContent = (content: unknown): unknown => {
    if (typeof content === 'string') return redactText(content);
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (typeof block !== 'object' || block === null) return block;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return { ...b, text: redactText(b.text) };
      return b;
    });
  };

  return async (ctx, next) => {
    const msgs = ctx.body.messages;
    if (Array.isArray(msgs)) {
      ctx.body = {
        ...ctx.body,
        messages: msgs.map((m) => {
          if (typeof m !== 'object' || m === null) return m;
          const msg = m as Record<string, unknown>;
          return { ...msg, content: redactContent(msg.content) };
        }),
      };
    }
    return next();
  };
}
