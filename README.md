# llm-gateway

A TypeScript gateway that sits between your LLM clients and Anthropic (or Ollama), emitting
[OpenTelemetry Gen AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) traces
to a self-hosted [Langfuse](https://langfuse.com) instance.

Primary use case: running [Claude Code](https://claude.ai/code) through the gateway via
`ANTHROPIC_BASE_URL` to get per-request token tracking, latency, and model observability
without changing any client code.

## Status

**v0.5** — Formalized `ProviderAdapter` interface; adding a new LLM provider is now a single file.
Agent session groundwork: W3C trace context propagation and `x-session-id` header for correlating
multi-call agent runs in Langfuse.

## How it works

```
Claude Code ──► llm-gateway :3001 ──► api.anthropic.com
                     │          └───► Ollama (ollama/* models)
                     │
                     └──► Langfuse (via OTLP)
                          gen_ai.system
                          gen_ai.request.model
                          gen_ai.usage.input_tokens
                          gen_ai.usage.output_tokens
                          gen_ai.response.finish_reasons
```

Every request to `POST /v1/messages` is routed to the appropriate provider based on
TypeScript routing rules. SSE streaming is piped through without buffering. A transform
stream reads SSE events in-flight to extract token usage, emitted as a `gen_ai.request`
span when the response completes.

Ollama requests are automatically translated between the Anthropic Messages API format
and Ollama's OpenAI-compatible API — the client always speaks Anthropic.

## Prerequisites

- Node.js 22+
- A running [Langfuse](https://langfuse.com/docs/deployment/self-host) instance
  (Docker Compose quickstart: `docker-compose up -d` from the Langfuse repo)
- [Ollama](https://ollama.ai) (optional — only needed for `ollama/*` model routing)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```env
# Assuming Langfuse is running on port 3000
PORT=3001

# Langfuse OTLP endpoint
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces

# Langfuse project keys (Settings → API Keys)
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...

# Optional overrides (defaults shown)
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# OLLAMA_BASE_URL=http://localhost:11434
```

## Running

```bash
# Development (watch mode, loads .env)
npm run dev

# Production
npm run build
npm start
```

## Pointing Claude Code at the gateway

```bash
ANTHROPIC_BASE_URL=http://localhost:3001 claude
```

Or export it in your shell profile to make it permanent.

## Routing

Routing rules live in `src/routing/config.ts`. Rules are TypeScript functions —
no YAML, no DSL.

```typescript
import { firstMatch, whenModel, chain, anthropic, ollama } from './index';

export const router = firstMatch([
  // Route ollama/* models to local Ollama, fall back to Anthropic if unavailable
  whenModel(/^ollama\//i, chain(ollama, anthropic)),
]);
```

### Helpers

| Helper | Description |
|---|---|
| `whenModel(pattern, provider)` | Match on model name (string or regex) |
| `chain(p1, p2, ...)` | Try providers left-to-right; fall back on 5xx or network error |
| `firstMatch(rules, fallback?)` | Evaluate rules top-to-bottom; first match wins |

### Fallback behaviour

When a provider list is returned (via `chain`), the proxy tries each in order:
- **429 / 503 / 529** — retry the same provider with exponential backoff (see [Retries](#retries))
- **Other 5xx** — drain the body, try the next provider immediately
- **Network error** — try the next provider immediately
- **4xx** — forward to the client immediately (no retry)
- **All providers exhausted** — return 502

## Agent sessions

When an agent makes many LLM calls in a loop, the gateway can correlate them into a
single session in Langfuse using either of two mechanisms:

### `x-session-id` header — simple loops

Set the same UUID on every call in an agent run. The gateway attaches it as a `session.id` span attribute (standard OTel; also recognised
by Langfuse) and strips the header before forwarding to upstream.

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';

const client = new Anthropic({ baseURL: 'http://localhost:3001' });
const sessionId = randomUUID();

for (const step of agentSteps) {
  await client.messages.create(step, {
    headers: { 'x-session-id': sessionId },
  });
}
```

### W3C `traceparent` — OTel-instrumented frameworks

If your agent framework (LangChain, CrewAI, custom OTel setup) propagates W3C trace
context, the gateway automatically nests its `gen_ai.request` spans as children of the
incoming trace. No code changes needed on the client side.

## Retries

The proxy retries 429 (rate limited), 503 (service unavailable), and 529 (Anthropic
overloaded) on the same provider before falling back to the next one.

**Backoff**: full jitter — `random(0, baseDelay × 2^attempt)`. If the upstream sends a
`Retry-After` header (≤ 60 s), that value is used instead.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `MAX_RETRIES` | `3` | Per-provider retry attempts |
| `RETRY_BASE_DELAY_MS` | `1000` | Base delay for backoff (ms) |

## Logging

Request logs are written as structured JSON to stdout — compatible with CloudWatch,
Datadog, or any log aggregation tool.

```json
{"level":30,"time":1748470913,"requestId":"a3f7b912","method":"POST","path":"/v1/messages",
 "status":200,"latencyMs":487,"model":"claude-sonnet-4-6","provider":"anthropic",
 "inputTokens":343,"outputTokens":13,"costUsd":0.000224}
```

In development (`NODE_ENV=development`), set `LOG_LEVEL=debug` and logs are formatted
with `pino-pretty` for readability.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |

## Cost tracking

The `gen_ai.usage.cost_usd` span attribute is set on every non-streaming response where
the model is in the pricing table. Cost also appears in the request log as `costUsd`.

Pricing data lives in `src/pricing/anthropic.ts` (auto-generated). To refresh it:

```bash
npm run update-pricing
```

The script fetches the [LiteLLM community pricing registry](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
validates the schema, prints a human-readable diff, and regenerates the file. It exits
non-zero if the upstream schema changes in a breaking way, so CI fails loudly.

A GitHub Actions workflow (`.github/workflows/update-pricing.yml`) runs this every
Monday and opens a PR when prices change.

## What you see in Langfuse

Each request produces a `gen_ai.request` span with:

| Attribute | Example |
|---|---|
| `gen_ai.system` | `anthropic` or `ollama` |
| `gen_ai.request.model` | `claude-sonnet-4-6` |
| `gen_ai.request.max_tokens` | `32000` |
| `gen_ai.response.model` | `claude-sonnet-4-6` |
| `gen_ai.usage.input_tokens` | `343` |
| `gen_ai.usage.output_tokens` | `13` |
| `gen_ai.usage.cost_usd` | `0.000224` |
| `gen_ai.response.finish_reasons` | `["end_turn"]` |

`gen_ai.system` reflects the provider that actually handled the request — useful for
distinguishing local vs. cloud inference in Langfuse dashboards.

## Docker

```bash
docker build -t llm-gateway .
docker run -p 3001:3001 \
  -e OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:3000/api/public/otel/v1/traces \
  -e LANGFUSE_PUBLIC_KEY=pk-lf-... \
  -e LANGFUSE_SECRET_KEY=sk-lf-... \
  llm-gateway
```

The multi-stage Dockerfile builds in `node:22-alpine`, copies only compiled output into
the final image. No dev dependencies or TypeScript source in the production image.

For AWS deployment, see the companion CDK construct:
[cdk-llm-gateway](https://github.com/kevinkempf/cdk-llm-gateway).

## Adding a provider

Implement `ProviderAdapter` from `src/adapters/types.ts`:

```typescript
// src/adapters/my-provider.ts
import type { ProviderAdapter } from './types';

export const myProviderAdapter: ProviderAdapter = {
  path: '/v1/chat/completions',           // upstream path
  translateRequest: (body) => { /* ... */ return translated; },
  translateResponse: (body) => { /* ... */ return translated; },
  createStreamTranslator: () => new MyStreamTransform(),
};
```

Then add a `Provider` entry in `src/routing/index.ts` and reference it in
`src/routing/config.ts`. The existing Ollama adapter is the reference implementation.

## Design decisions

**Provider adapters as a formal interface.** `ProviderAdapter` defines the three
translation surfaces — request body, response body, SSE stream — so new providers are
drop-in files with no changes to the router or proxy. The `anthropicAdapter` is an
identity pass-through; the `ollamaAdapter` is the reference implementation of a full
translation.

**Routing policies as TypeScript functions.** Rules are typed predicates — `whenModel`,
`chain`, `firstMatch`. No YAML DSL, no CEL expressions. Adding a rule is adding a line
of code with full type safety and IDE autocomplete.

**Anthropic API surface preserved end-to-end.** Ollama uses an OpenAI-compatible API;
the gateway translates requests and responses transparently so all clients speak the
Anthropic Messages API regardless of which provider handles the request.

**SSE never buffered.** The streaming response is piped through a Transform stream that
reads events in-flight. The client receives bytes as they arrive; nothing is held in
memory waiting for the response to complete.

**OTel Gen AI semantic conventions.** Spans use the
[`gen_ai.*` attribute namespace](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
so traces are interoperable with any OTel-compatible backend, not just Langfuse.

**`accept-encoding: identity` enforced upstream.** Compressed responses can't be parsed
for telemetry. The gateway requests uncompressed from upstream and forwards uncompressed
to the client.

## Roadmap

- [x] v0.1 — transparent Anthropic proxy + OTel observability
- [x] v0.2 — TypeScript routing policies, Ollama adapter, fallback chains
- [x] v0.3 — cost tracking, exponential retry with backoff, structured pino logging
- [x] v0.4 — CDK construct for ECS Fargate deployment ([cdk-llm-gateway](https://github.com/kevinkempf/cdk-llm-gateway))
- [x] v0.5 — formalized `ProviderAdapter` interface; drop-in provider plugins; agent session groundwork (`x-session-id`, W3C trace context)
- [ ] v0.6 — compile-time middleware chain (cost guards, rate limiting, PII redaction)

## License

MIT
