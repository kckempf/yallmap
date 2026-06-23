/**
 * Routing configuration — edit this file to define your provider rules.
 *
 * Rules are evaluated top-to-bottom; the first match wins.
 * Requests that match no rule fall through to the fallback provider (anthropic).
 *
 * Available helpers:
 *   whenModel(pattern, provider)         — match on model name (string or regex)
 *   chain(provider, ...fallbacks)        — try providers left-to-right on 5xx or network error
 *   firstMatch(rules, fallback?)         — combine rules into a router
 *
 * Available providers:
 *   anthropic  — api.anthropic.com  (override with ANTHROPIC_BASE_URL)
 *   ollama     — localhost:11434    (override with OLLAMA_BASE_URL)
 *
 * modelOverride: maps the incoming model name to a different name on the target provider.
 * Useful for routing Claude Code's claude-* model names to local Ollama models:
 *
 *   import { ollamaAdapter } from '../adapters';
 *   const ollamaHaiku = { ...ollama, modelOverride: 'qwen3:8b' };
 *   whenModel('claude-haiku-4-5', chain(ollamaHaiku, anthropic))
 *     → haiku requests go to qwen3:8b locally, fall back to Anthropic if Ollama is down
 */
import { firstMatch, whenModel, anthropic, ollama } from './index';

export const router = firstMatch([
  whenModel(/^ollama\//i, ollama),  // ollama/* stays on Ollama — failures surface loudly instead of silently billing Anthropic
  // Route claude-haiku-4-5 to a local model, fall back to Anthropic:
  // whenModel('claude-haiku-4-5', chain({ ...ollama, modelOverride: 'qwen3:8b' }, anthropic)),
]);

// Re-export providers so users can reference them without a second import
export { anthropic, ollama };
