import type { MiddlewareFn } from './types';

export interface ApiKeyAuthOptions {
  keys: Map<string, string>;
  headerName?: string;
}

const DEFAULT_HEADER = 'x-gateway-key';

export function apiKeyAuth({ keys, headerName = DEFAULT_HEADER }: ApiKeyAuthOptions): MiddlewareFn {
  return async (ctx, next) => {
    const presented = ctx.clientHeaders[headerName];
    const keyId = presented ? keys.get(presented) : undefined;
    if (!keyId) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'unauthorized', message: 'invalid or missing gateway key' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
    ctx.auth = { keyId };
    return next();
  };
}

export function parseApiKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const colon = pair.indexOf(':');
    if (colon === -1) continue;
    const label = pair.slice(0, colon).trim();
    const secret = pair.slice(colon + 1).trim();
    if (label && secret) map.set(secret, label);
  }
  return map;
}
