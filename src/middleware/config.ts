/**
 * Middleware configuration — edit this file to add request/response middleware.
 *
 * Middleware runs before every upstream call in the order listed here.
 * Each function receives a context and a next() handler; calling next() forwards the
 * request. Returning without calling next() short-circuits the chain (e.g. to reject
 * a request).
 *
 * Available middleware:
 *   costGuard(limitUsd)                   — reject if worst-case cost exceeds limit
 *   rateLimit({ requests, windowMs })     — in-memory fixed-window per API key
 *   piiRedactor(patterns, replacement?)   — regex redaction from message text
 */
import type { MiddlewareFn } from './types';
// import { costGuard } from './costGuard';
// import { rateLimit } from './rateLimit';
// import { piiRedactor } from './piiRedactor';

export const middlewares: MiddlewareFn[] = [
  // costGuard(0.10),
  // rateLimit({ requests: 100, windowMs: 60_000 }),
  // piiRedactor([/\b\d{3}-\d{2}-\d{4}\b/g]),  // SSN pattern
];
