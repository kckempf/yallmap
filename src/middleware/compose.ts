import type { MiddlewareFn, MiddlewareContext, NextFn } from './types';

export function compose(middlewares: MiddlewareFn[]) {
  return (ctx: MiddlewareContext, handler: NextFn): Promise<Response> => {
    let called = -1;
    const dispatch = (i: number): Promise<Response> => {
      if (i <= called) return Promise.reject(new Error('next() called multiple times'));
      called = i;
      const fn = i < middlewares.length ? middlewares[i] : handler;
      return Promise.resolve(fn(ctx, () => dispatch(i + 1)));
    };
    return dispatch(0);
  };
}
