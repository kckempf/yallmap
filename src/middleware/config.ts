/**
 * Middleware configuration — edit this file to add request/response middleware.
 *
 * Middleware runs before every upstream call in the order listed here.
 * Each function receives a context and a next() handler; calling next() forwards the
 * request. Returning without calling next() short-circuits the chain (e.g. to reject
 * a request).
 *
 * Available middleware:
 *   apiKeyAuth({ keys })                  — reject requests without a valid gateway key
 *   costGuard(limitUsd)                   — reject if worst-case cost exceeds limit
 *   rateLimit({ requests, windowMs })     — in-memory fixed-window per identity / API key
 *   piiRedactor(patterns, replacement?)   — regex redaction from message text
 *
 * Auth is auto-enabled when GATEWAY_API_KEYS is set in the environment:
 *   GATEWAY_API_KEYS=alice:secret123,bob:secret456
 * Clients then send `x-gateway-key: secret123` to authenticate as "alice".
 *
 * When GATEWAY_API_KEYS is unset, the gateway runs unauthenticated — fine for local
 * development, dangerous in production. A warning is logged in production.
 */
import type { MiddlewareFn } from './types';
import { apiKeyAuth, parseApiKeys } from './apiKeyAuth';
// import { costGuard } from './costGuard';
// import { rateLimit } from './rateLimit';
// import { piiRedactor } from './piiRedactor';

const apiKeys = parseApiKeys(process.env.GATEWAY_API_KEYS);

if (!apiKeys.size && process.env.NODE_ENV === 'production') {
  console.warn('[middleware] GATEWAY_API_KEYS not set — gateway is unauthenticated');
}

export const middlewares: MiddlewareFn[] = [
  ...(apiKeys.size ? [apiKeyAuth({ keys: apiKeys })] : []),
  // costGuard(0.10),
  // rateLimit({ requests: 100, windowMs: 60_000 }),
  // piiRedactor([/\b\d{3}-\d{2}-\d{4}\b/g]),  // SSN pattern
];
