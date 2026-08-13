/**
 * Provider abstraction (Issue #12 section 18). The orchestrator must not
 * assume one LLM vendor, and persona semantics must not change based on
 * which provider actually answers. ModelProvider is the seam: every phase
 * handler talks to this interface, never to a vendor SDK or even directly
 * to ProviderRouter.
 */
import type { ProviderRouter } from '../providers/router.js';
import type { PersonaCodename, Phase } from './types.js';

export interface PersonaRequest {
  persona: PersonaCodename;
  phase: Phase;
  systemPrompt: string;
  userPrompt: string;
  /** Ask for a JSON-shaped completion when the provider supports response_format. */
  json: boolean;
  temperature?: number;
}

export interface PersonaResponse {
  text: string;
  provider: string;
  model: string;
}

export interface ModelProvider {
  generate(request: PersonaRequest): Promise<PersonaResponse>;
}

/** Wraps the existing OpenAI-compatible ProviderRouter behind ModelProvider, so nothing above this line ever imports a vendor SDK. */
export function fromProviderRouter(router: ProviderRouter): ModelProvider {
  return {
    async generate(request: PersonaRequest): Promise<PersonaResponse> {
      const result = await router.complete({
        system: request.systemPrompt,
        user: request.userPrompt,
        json: request.json,
        temperature: request.temperature,
      });
      return { text: result.text, provider: result.provider, model: result.model };
    },
  };
}

/**
 * Config-driven persona -> model tier -> ModelProvider routing
 * (orchestration.yaml's `model_routing`). Tier labels are arbitrary
 * strings chosen by configuration, never vendor names — see
 * config/council/orchestration.yaml, which deliberately names no vendor.
 */
export class RoutedModelProviderPool {
  constructor(
    private readonly tierProviders: Record<string, ModelProvider>,
    private readonly routing: Partial<Record<PersonaCodename, string>>,
    private readonly defaultTier: string,
  ) {
    if (!(defaultTier in tierProviders)) {
      throw new Error(`RoutedModelProviderPool: default tier "${defaultTier}" has no configured provider`);
    }
  }

  forPersona(codename: PersonaCodename): ModelProvider {
    const tier = this.routing[codename] ?? this.defaultTier;
    const provider = this.tierProviders[tier] ?? this.tierProviders[this.defaultTier];
    if (!provider) {
      throw new Error(`RoutedModelProviderPool: no provider configured for tier "${tier}" or default "${this.defaultTier}"`);
    }
    return provider;
  }
}

/**
 * Every tier maps to the same underlying chain today, because Half-Shell's
 * config currently exposes one ordered provider fallback chain
 * (HALF_SHELL_PROVIDERS), not one per tier. The abstraction is real and
 * tested independently of this — RoutedModelProviderPool works correctly
 * with genuinely distinct providers per tier, this constructor is just
 * the version that matches what config.ts loads today. Widening it to
 * parse tier-specific env vars is additive, not architectural.
 */
export function poolFromSingleChain(router: ProviderRouter, tiers: string[], defaultTier: string): RoutedModelProviderPool {
  const provider = fromProviderRouter(router);
  const tierProviders = Object.fromEntries(tiers.map((tier) => [tier, provider]));
  return new RoutedModelProviderPool(tierProviders, {}, defaultTier);
}
