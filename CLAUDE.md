# LLM Gateway Project Context

## What this is
Anthropic-native LLM gateway in TypeScript. Primary client is Claude Code 
itself via ANTHROPIC_BASE_URL. Emits OTel traces to self-hosted Langfuse.

## Architectural decisions already made
- Anthropic API first (not OpenAI), because Claude Code is the primary workload
- Routing policies as TypeScript functions, not YAML/CEL/config
- OTel gen_ai.* semantic conventions for trace emission
- Langfuse as the observability backend (self-hosted)
- CDK constructs for deployment (extends my existing cdk-dms-replication work)

## v0.1 scope (this session)
- POST /v1/messages route only
- Transparent pass-through to api.anthropic.com
- Preserve all headers (x-api-key, anthropic-version, anthropic-beta)
- SSE streaming piped through — never buffer
- OTel span emission to Langfuse

## Gotchas to design for
- Streaming: pipe upstream response directly, never .on('data') and collect
- Tool-use IDs: preserve every field, don't strip unknown ones
- Auth headers: don't rewrite x-api-key unless upstream expects different scheme

## Differentiation hooks (later, not v0.1)
- Hybrid local/cloud routing (M5 Max Ollama + Anthropic)
- Code-based policies via TypeScript predicates
- CDK constructs for AWS deployment

## What I'm NOT building
- OpenAI compatibility (defer)
- Routing logic (defer)
- Caching (defer)
- Anything beyond transparent proxy + observability for v0.1