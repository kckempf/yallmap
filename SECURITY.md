# Security Policy

## Reporting a vulnerability

**Please do not file public GitHub issues for security bugs.** Vulnerabilities
reported in public issue trackers are visible to everyone — including
attackers — before a fix is available.

Use one of the private channels below:

1. **Preferred — GitHub private vulnerability reporting.** Go to the
   repository's [Security tab](https://github.com/kevinkempf/llm-gateway/security)
   and click "Report a vulnerability." This routes the report directly to
   the maintainers and creates a private discussion for triage.

When reporting, please include:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept if available.
- The gateway version (`git rev-parse HEAD` or release tag) you tested
  against.
- Any relevant configuration (provider, auth setup, etc.) — redact secrets.

You can expect an initial acknowledgement within five business days. We will
work with you on disclosure timing; we typically aim to ship a fix and
coordinate a public disclosure within 90 days of the report, sooner if the
vulnerability is being actively exploited.

## Supported versions

The project is pre-1.0 and ships from a single line of development. Only the
**latest minor release** receives security fixes; older minors should
upgrade.

| Version | Supported |
|---------|-----------|
| 0.8.x   | Yes       |
| < 0.8   | No        |

## Scope

In scope:

- The gateway code itself (request handling, middleware, provider adapters,
  telemetry).
- The default configuration the project ships with.
- The published Docker image, if one exists.

Out of scope:

- Upstream provider APIs (Anthropic, Ollama, etc.) — report those to the
  upstream vendor.
- Self-hosted Langfuse — report to the
  [Langfuse project](https://github.com/langfuse/langfuse).
- Misconfiguration by an operator (e.g. running with `GATEWAY_API_KEYS`
  unset on a public endpoint) — see the README for hardening guidance.

## Known limitations

The README and CHANGELOG document known operational caveats (in-memory rate
limit state, etc.). These are not security vulnerabilities; they are bounded
operational tradeoffs to be aware of when deploying.
