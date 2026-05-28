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
 */
import { firstMatch, whenModel, chain, anthropic, ollama } from './index';

export const router = firstMatch([
  whenModel(/^ollama\//i, chain(ollama, anthropic)),  // fall back to Anthropic if Ollama is unavailable
  // Add your rules here, for example:
  // whenModel(/^mistral\//, ollama),
  // whenModel('claude-haiku-4-5', anthropic),
]);

// Re-export providers so users can reference them without a second import
export { anthropic, ollama };
