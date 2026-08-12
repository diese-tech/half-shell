import { describe, expect, it } from 'vitest';

import { parseJsonArray, parseJsonObject } from './json.js';
import { ProviderRouter } from './router.js';
import { ProviderError, type CompletionResult, type Provider, type ProviderTier } from './types.js';

class StubProvider implements Provider {
  calls = 0;

  constructor(
    readonly id: string,
    readonly tier: ProviderTier,
    private readonly behaviour: 'ok' | 'retryable' | 'fatal',
  ) {}

  readonly model = 'stub';

  async complete(): Promise<CompletionResult> {
    this.calls += 1;
    if (this.behaviour === 'ok') return { text: 'ok', provider: this.id, model: this.model };
    throw new ProviderError(`${this.id} failed`, this.id, this.behaviour === 'retryable');
  }
}

describe('ProviderRouter', () => {
  it('falls back to the next provider in the chain', async () => {
    const free = new StubProvider('free', 'free', 'retryable');
    const local = new StubProvider('local', 'local', 'ok');
    const router = new ProviderRouter([free, local], { allowPaid: false });

    const result = await router.complete({ system: 's', user: 'u' });

    expect(result.provider).toBe('local');
    expect(free.calls).toBe(2); // retryable errors are retried once
    expect(router.used).toEqual(['local']);
  });

  it('does not retry a provider that failed fatally', async () => {
    const fatal = new StubProvider('fatal', 'free', 'fatal');
    const local = new StubProvider('local', 'local', 'ok');
    await new ProviderRouter([fatal, local], { allowPaid: false }).complete({
      system: 's',
      user: 'u',
    });

    expect(fatal.calls).toBe(1);
  });

  it('never uses a paid provider unless explicitly allowed', async () => {
    const paid = new StubProvider('paid', 'paid', 'ok');
    const router = new ProviderRouter([paid], { allowPaid: false });

    expect(router.isEmpty).toBe(true);
    await expect(router.complete({ system: 's', user: 'u' })).rejects.toThrow(/no inference providers/);
    expect(paid.calls).toBe(0);
  });

  it('uses a paid provider once the operator opts in', async () => {
    const paid = new StubProvider('paid', 'paid', 'ok');
    const router = new ProviderRouter([paid], { allowPaid: true });

    await expect(router.complete({ system: 's', user: 'u' })).resolves.toMatchObject({
      provider: 'paid',
    });
  });

  it('reports every failure when the whole chain is exhausted', async () => {
    const router = new ProviderRouter(
      [new StubProvider('a', 'free', 'fatal'), new StubProvider('b', 'local', 'fatal')],
      { allowPaid: false },
    );

    await expect(router.complete({ system: 's', user: 'u' })).rejects.toThrow(/all providers failed/);
  });
});

describe('json recovery', () => {
  it('reads a fenced object', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads an object buried in prose', () => {
    expect(parseJsonObject('Sure! Here it is: {"a": {"b": 2}} — hope that helps')).toEqual({
      a: { b: 2 },
    });
  });

  it('is not confused by braces inside strings', () => {
    expect(parseJsonObject('{"a": "} not the end {"}')).toEqual({ a: '} not the end {' });
  });

  it('unwraps an array from a named key', () => {
    expect(parseJsonArray('{"findings": [{"id": 1}]}', ['findings'])).toEqual([{ id: 1 }]);
  });

  it('returns an empty array for unusable output', () => {
    expect(parseJsonArray('the model apologises profusely')).toEqual([]);
  });
});
