# Contributing to llm-gateway

Thanks for your interest. This project is small and opinionated; the guidelines
below exist so contributions land cleanly with minimal back-and-forth.

## Development setup

```bash
git clone https://github.com/kevinkempf/llm-gateway && cd llm-gateway
npm install
cp .env.example .env       # edit to taste; Langfuse vars are optional
npm test                   # vitest, expect green
npm run typecheck          # tsc --noEmit
npm run dev                # starts the gateway on :3001 (configurable)
```

Node 20+ is required.

## Branch model

- Open pull requests against `main`.
- Keep branches focused: one logical change per PR is much easier to review
  than a grab-bag.
- Rebase rather than merge when bringing a branch up to date.

## Commit style

Follow the existing prefix convention (Conventional Commits-lite):

- `feat:` — new user-visible capability
- `fix:` — bug fix
- `chore:` — tooling, dependencies, build, scripts
- `docs:` — documentation only
- `refactor:` — internal change with no behavior shift
- `test:` — test additions or fixes

Subject line ≤ 72 chars, imperative mood ("add retry jitter", not "added"
or "adds"). Body explains the *why* when it isn't obvious from the diff.

## TDD requirement

Every PR that touches runtime code must include co-located `*.test.ts` files
covering the new behavior. We use [Vitest](https://vitest.dev/) — tests sit
next to the code they exercise (e.g. `src/middleware/rateLimit.test.ts` lives
alongside `src/middleware/rateLimit.ts`). Bug fixes need a regression test
that fails on `main` and passes on the branch.

`npm test` runs the full suite; `npm run test:watch` is the inner-loop tool.

## How to add a provider adapter

The cleanest reference is `src/adapters/ollama.ts` plus its tests. The
adapter interface (`src/adapters/types.ts`) requires four things:

1. `path` — the upstream HTTP path the gateway POSTs to.
2. `translateRequest(body)` — convert Anthropic-shaped requests to the
   upstream's schema. Return the body as-is if the upstream is already
   Anthropic-compatible.
3. `translateResponse(body)` — convert non-streaming JSON responses back
   to the Anthropic shape.
4. `createStreamTranslator()` — return a Node `Transform` stream that
   converts the upstream's SSE events to Anthropic SSE chunk-by-chunk.

Register the adapter in `src/routing/index.ts` and reference it from
`src/routing/config.ts`. Tests should cover both streaming and
non-streaming paths.

## How to add middleware

See `src/middleware/costGuard.ts` for the canonical shape and
`src/middleware/costGuard.test.ts` for the test pattern. A middleware is a
factory returning `(ctx, next) => Promise<Response>`. Read or mutate the
`MiddlewareContext`, short-circuit by returning a `Response` without calling
`next()`, or call `await next()` to continue the chain.

Register new middleware in `src/middleware/config.ts`. Middleware order is
significant — auth runs before identity-aware downstream middleware
(`rateLimit`, etc.).

## Reporting issues

For bugs and feature requests, use the GitHub issue templates. **For security
vulnerabilities, do not open a public issue** — see [SECURITY.md](SECURITY.md).
