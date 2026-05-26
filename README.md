# llm-gateway

A TypeScript gateway that sits between your LLM clients and Anthropic, emitting
[OpenTelemetry Gen AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) traces
to a self-hosted [Langfuse](https://langfuse.com) instance.

Primary use case: running [Claude Code](https://claude.ai/code) through the gateway via
`ANTHROPIC_BASE_URL` to get per-request token tracking, latency, and model observability
without changing any client code.

## Status

**v0.1** — transparent proxy + OTel observability. Routing, multi-provider support, and
CDK deployment constructs are on the roadmap.

## How it works

```
Claude Code ──► llm-gateway :3001 ──► api.anthropic.com
                     │
                     └──► Langfuse (via OTLP)
                          gen_ai.request.model
                          gen_ai.usage.input_tokens
                          gen_ai.usage.output_tokens
                          gen_ai.response.finish_reasons
```

Every request to `POST /v1/messages` is forwarded verbatim to Anthropic. SSE streaming
is piped through without buffering. A transform stream reads the SSE events in-flight to
extract token usage, which is emitted as a `gen_ai.request` span when the response
completes.

## Prerequisites

- Node.js 20+
- A running [Langfuse](https://langfuse.com/docs/deployment/self-host) instance
  (Docker Compose quickstart: `docker-compose up -d` from the Langfuse repo)

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
# Open Claude Code in the CLI pointing to the gateway
ANTHROPIC_BASE_URL=http://localhost:3001 claude
```

Or export it in your shell profile to make it permanent.

## What you see in Langfuse

Each request produces a `gen_ai.request` span with:

| Attribute | Example |
|---|---|
| `gen_ai.system` | `anthropic` |
| `gen_ai.request.model` | `claude-sonnet-4-6` |
| `gen_ai.request.max_tokens` | `32000` |
| `gen_ai.response.model` | `claude-sonnet-4-6` |
| `gen_ai.usage.input_tokens` | `343` |
| `gen_ai.usage.output_tokens` | `13` |
| `gen_ai.response.finish_reasons` | `["end_turn"]` |

## Design decisions

**Routing policies as TypeScript functions, not config.** The v0.2 routing layer will
use typed predicates to express rules like "send free-tier users to a local model, fall
back to Anthropic on capacity". No YAML DSL, no CEL expressions — just code.

**SSE never buffered.** The streaming response is piped through a Transform stream that
reads events in-flight. The client receives bytes as they arrive; nothing is held in
memory waiting for the response to complete.

**OTel Gen AI semantic conventions.** Spans use the
[`gen_ai.*` attribute namespace](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
so traces are interoperable with any OTel-compatible backend, not just Langfuse.

**`accept-encoding: identity` enforced upstream.** Compressed responses can't be parsed
for telemetry. The gateway requests uncompressed from Anthropic and forwards uncompressed
to the client — the client handles either format.

## Roadmap

- **v0.2** — provider registry, TypeScript routing policies, fallback chains, Ollama support
- **v0.3** — cost tracking, retries, structured request logging
- **v0.4** — CDK constructs for AWS deployment

## License

MIT
