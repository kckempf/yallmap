# llm-gateway

A TypeScript gateway that sits between your LLM clients and Anthropic (or Ollama), emitting
[OpenTelemetry Gen AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) traces
to a self-hosted [Langfuse](https://langfuse.com) instance.

Primary use case: running [Claude Code](https://claude.ai/code) through the gateway via
`ANTHROPIC_BASE_URL` to get per-request token tracking, latency, and model observability
without changing any client code.

## Status

**v0.2** — TypeScript routing policies, Ollama support, fallback chains, OTel observability.

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

- Node.js 20+
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
- **Network error** — try the next provider
- **5xx response** — drain the body, try the next provider
- **4xx response** — forward to the client immediately (no retry)
- **All providers exhausted** — return 502

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
| `gen_ai.response.finish_reasons` | `["end_turn"]` |

`gen_ai.system` reflects the provider that actually handled the request — useful for
distinguishing local vs. cloud inference in Langfuse dashboards.

## Design decisions

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
- [ ] v0.3 — cost tracking, retries, structured request logging
- [ ] v0.4 — CDK constructs for AWS deployment

## License

MIT
