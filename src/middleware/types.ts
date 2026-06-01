export interface MiddlewareContext {
  readonly requestId: string;
  readonly model: string;
  readonly isStreaming: boolean;
  readonly maxTokens: number | undefined;
  body: Record<string, unknown>;
  readonly clientHeaders: Readonly<Record<string, string>>;
}

export type NextFn = () => Promise<Response>;
export type MiddlewareFn = (ctx: MiddlewareContext, next: NextFn) => Promise<Response>;
