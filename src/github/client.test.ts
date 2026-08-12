import { describe, expect, it } from 'vitest';

import { retryDelayMs } from './client.js';

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

describe('retryDelayMs', () => {
  it('retries server errors with growing backoff', () => {
    expect(retryDelayMs(response(500), '', 1)).toBe(1000);
    expect(retryDelayMs(response(502), '', 2)).toBe(2000);
    expect(retryDelayMs(response(503), '', 3)).toBe(4000);
  });

  it('honours Retry-After ahead of its own backoff', () => {
    expect(retryDelayMs(response(429, { 'retry-after': '7' }), '', 1)).toBe(7000);
  });

  it('caps an absurd Retry-After', () => {
    expect(retryDelayMs(response(429, { 'retry-after': '9999' }), '', 1)).toBe(60_000);
  });

  it('retries a secondary rate limit, which arrives as a 403', () => {
    const detail = 'You have exceeded a secondary rate limit. Please wait a few minutes.';
    expect(retryDelayMs(response(403), detail, 1)).toBe(1000);
  });

  it('waits out a primary rate limit that clears soon', () => {
    const reset = Math.floor((Date.now() + 20_000) / 1000);
    const wait = retryDelayMs(
      response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      '',
      1,
    );
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(20_000);
  });

  it('gives up on a primary rate limit that is far away', () => {
    const reset = Math.floor((Date.now() + 30 * 60_000) / 1000);
    expect(
      retryDelayMs(
        response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
        '',
        1,
      ),
    ).toBeUndefined();
  });

  it('does not retry ordinary client errors', () => {
    expect(retryDelayMs(response(404), 'Not Found', 1)).toBeUndefined();
    expect(retryDelayMs(response(422), 'Validation failed', 1)).toBeUndefined();
    expect(retryDelayMs(response(401), 'Bad credentials', 1)).toBeUndefined();
    expect(retryDelayMs(response(403), 'Resource not accessible by integration', 1)).toBeUndefined();
  });
});
