import { describe, expect, it } from 'vitest';

import { retryDelayMs } from './client.js';

function response(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const READ = true;
const WRITE = false;

describe('retryDelayMs', () => {
  it('retries server errors on reads with growing backoff', () => {
    expect(retryDelayMs(response(500), '', 1, READ)).toBe(1000);
    expect(retryDelayMs(response(502), '', 2, READ)).toBe(2000);
    expect(retryDelayMs(response(503), '', 3, READ)).toBe(4000);
  });

  it('never replays a write after an ambiguous server error', () => {
    // The review may already have been posted; a retry would duplicate it.
    expect(retryDelayMs(response(500), '', 1, WRITE)).toBeUndefined();
    expect(retryDelayMs(response(502), '', 1, WRITE)).toBeUndefined();
  });

  it('retries a rate-limited write, which GitHub rejected before acting', () => {
    expect(retryDelayMs(response(429), '', 1, WRITE)).toBe(1000);
    const secondary = 'You have exceeded a secondary rate limit. Please wait a few minutes.';
    expect(retryDelayMs(response(403), secondary, 1, WRITE)).toBe(1000);
  });

  it('honours Retry-After ahead of its own backoff', () => {
    expect(retryDelayMs(response(429, { 'retry-after': '7' }), '', 1, READ)).toBe(7000);
  });

  it('caps an absurd Retry-After', () => {
    expect(retryDelayMs(response(429, { 'retry-after': '9999' }), '', 1, READ)).toBe(60_000);
  });

  it('waits out a primary rate limit that clears soon', () => {
    const reset = Math.floor((Date.now() + 20_000) / 1000);
    const wait = retryDelayMs(
      response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      '',
      1,
      READ,
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
        READ,
      ),
    ).toBeUndefined();
  });

  it('does not retry ordinary client errors', () => {
    expect(retryDelayMs(response(404), 'Not Found', 1, READ)).toBeUndefined();
    expect(retryDelayMs(response(422), 'Validation failed', 1, READ)).toBeUndefined();
    expect(retryDelayMs(response(401), 'Bad credentials', 1, READ)).toBeUndefined();
    expect(
      retryDelayMs(response(403), 'Resource not accessible by integration', 1, READ),
    ).toBeUndefined();
  });
});
