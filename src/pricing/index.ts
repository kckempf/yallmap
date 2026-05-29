import { ANTHROPIC_PRICING } from './anthropic';

export type { ModelPricing } from './anthropic';

export function estimateCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number }
): number | null {
  const pricing = ANTHROPIC_PRICING[model];
  if (!pricing) return null;
  return (
    usage.input_tokens * pricing.inputCostPerToken +
    usage.output_tokens * pricing.outputCostPerToken
  );
}
