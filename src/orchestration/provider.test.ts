import { describe, expect, it } from 'vitest';

import { RoutedModelProviderPool, type ModelProvider, type PersonaRequest } from './provider.js';

function fakeProvider(name: string): ModelProvider {
  return {
    async generate(_request: PersonaRequest) {
      return { text: '{}', provider: name, model: `${name}-model` };
    },
  };
}

describe('RoutedModelProviderPool — provider/model routing is configuration-driven', () => {
  it('routes a persona to its configured tier', async () => {
    const pool = new RoutedModelProviderPool(
      { local_or_free: fakeProvider('local'), strongest_available_model: fakeProvider('strong') },
      { leo: 'strongest_available_model', raph: 'local_or_free' },
      'local_or_free',
    );

    const leoResult = await pool.forPersona('leo').generate({ persona: 'leo', phase: 'LEO_REVIEW', systemPrompt: '', userPrompt: '', json: true });
    const raphResult = await pool.forPersona('raph').generate({ persona: 'raph', phase: 'INDEPENDENT_REVIEW', systemPrompt: '', userPrompt: '', json: true });

    expect(leoResult.provider).toBe('strong');
    expect(raphResult.provider).toBe('local');
  });

  it('falls back to the default tier for a persona with no explicit route', async () => {
    const pool = new RoutedModelProviderPool(
      { local_or_free: fakeProvider('local') },
      {},
      'local_or_free',
    );
    const result = await pool.forPersona('mikey').generate({ persona: 'mikey', phase: 'INDEPENDENT_REVIEW', systemPrompt: '', userPrompt: '', json: true });
    expect(result.provider).toBe('local');
  });

  it('names no vendor anywhere in its own configuration surface', () => {
    // The tier labels are arbitrary strings — nothing in this pool's API
    // requires or even recognizes a vendor name.
    const pool = new RoutedModelProviderPool({ whatever_i_call_it: fakeProvider('x') }, { leo: 'whatever_i_call_it' }, 'whatever_i_call_it');
    expect(pool.forPersona('leo')).toBeDefined();
  });

  it('rejects construction when the default tier has no provider', () => {
    expect(() => new RoutedModelProviderPool({}, {}, 'missing_tier')).toThrow();
  });

  it('falls back to the default tier if a routed tier is somehow unconfigured', async () => {
    const pool = new RoutedModelProviderPool(
      { local_or_free: fakeProvider('local') },
      { leo: 'strongest_available_model' }, // never actually configured
      'local_or_free',
    );
    const result = await pool.forPersona('leo').generate({ persona: 'leo', phase: 'LEO_REVIEW', systemPrompt: '', userPrompt: '', json: true });
    expect(result.provider).toBe('local');
  });
});
