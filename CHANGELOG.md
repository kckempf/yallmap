# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-06-03

### Added

- Multi-key authentication middleware (`apiKeyAuth`). Configure via
  `GATEWAY_API_KEYS=alice:secret123,bob:secret456`; clients present the
  `x-gateway-key` header. Identity propagates to rate limiting, request
  logs, and OTel spans (`user.id` attribute) for per-user observability.
- Body size limit on `/v1/messages` (default 4 MB, override via
  `MAX_BODY_BYTES`). Oversized requests get a 413 before any allocation.
- `src/version.ts` reads the package version at runtime so health checks,
  OTel resource attributes, and tracer instrumentation versions stay in
  sync with `package.json`.
- `RETRY_AFTER_MAX_MS` (default 5 minutes) caps how long the proxy will
  honor an upstream `Retry-After` header. Previously values above 60 s
  were discarded; now they are clamped, so server-directed back-off still
  applies on long Anthropic 429s.
- OSS governance files: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `CHANGELOG.md`.
- GitHub Actions CI (typecheck + tests on Node 20 and 22), Dependabot
  configuration, and issue / pull request templates.

### Changed

- `MiddlewareContext` gained an optional `auth?: AuthIdentity` field so
  downstream middleware can read the authenticated identity.
- Default `rateLimit` key function now prefers `ctx.auth?.keyId` over the
  raw upstream `x-api-key`, so per-user limits work without custom config.
- Retry backoff switched from full jitter (`random * cap`) to equal jitter
  (`cap/2 + random * cap/2`). Delays now grow monotonically with the
  attempt number, preventing back-to-back retries that previously
  exhausted the budget in a few hundred milliseconds.
- `package.json` version bumped to `0.7.0` and now includes `license`,
  `author`, `repository`, `homepage`, `bugs`, and `keywords` metadata.

## [0.6.0] - prior

### Added for 0.6.0

- Compile-time middleware chain via `compose`, exposed as the
  `middlewares` array in `src/middleware/config.ts`. Middleware runs
  before every upstream call and can short-circuit by returning its own
  `Response`.
- Built-in middleware: `costGuard(limitUsd)`, `rateLimit({ requests,
  windowMs, keyFn? })`, and `piiRedactor(patterns, replacement?)`.
- Opt-in content capture (`CAPTURE_CONTENT=true`) that records prompt and
  completion text as `gen_ai.prompt` / `gen_ai.completion` span
  attributes. Off by default so message content stays out of telemetry.

## [0.5.0] - prior

### Added for 0.5.0

- Provider adapter interface (`src/providers/types.ts`). Adapters expose
  `path`, `translateRequest`, `translateResponse`, and
  `translateStreamChunk` so non-Anthropic upstreams can plug in cleanly.
- Ollama adapter with full streaming support: tool-use translation,
  `/no_think` handling, and sampling parameter passthrough.
- Local-model capability for Claude Code: route subsets of traffic to a
  local Ollama instance while keeping the same client SDK.

## [0.4.0] - prior

### Added for 0.4.0

- CDK construct for ECS Fargate deployment, shipped in the companion
  repository [`cdk-llm-gateway`](https://github.com/kevinkempf/cdk-llm-gateway).
  No changes to this repository in this release.

## [0.3.0] - prior

### Added for 0.3.0

- Per-request cost tracking (input/output tokens, USD) attached to the
  Hono context and emitted in the request log line.
- Exponential backoff with jitter for upstream retries plus
  `Retry-After` honoring on 429 / 503 / 529.
- Structured logging via pino with request-scoped fields.

## [0.2.0] - prior

### Added for 0.2.0

- Routing layer (`src/routing.ts`): code-defined predicates that map
  request shape to one or more upstream providers, with fallback.
- Streaming SSE proxy that pipes upstream chunks straight to the client
  without buffering.

## [0.1.0] - prior

### Added for 0.1.0

- Initial transparent proxy for `POST /v1/messages` to
  `api.anthropic.com`, preserving `x-api-key`, `anthropic-version`, and
  `anthropic-beta` headers.
- OTel `gen_ai.*` span emission to a configurable OTLP endpoint
  (Langfuse-compatible).
- `/health` endpoint returning version and status.
