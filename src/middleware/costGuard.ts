import { estimateCost } from '../pricing';
import type { MiddlewareFn } from './types';

export function costGuard(limitUsd: number): MiddlewareFn {
  return async (ctx, next) => {
    const worst = estimateCost(ctx.model, {
      input_tokens: ctx.maxTokens ?? 0,
      output_tokens: ctx.maxTokens ?? 0,
    });
    if (worst !== null && worst > limitUsd) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'cost_limit_exceeded',
            message: `Estimated cost $${worst.toFixed(4)} exceeds limit $${limitUsd.toFixed(4)}`,
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      );
    }
    return next();
  };
}
