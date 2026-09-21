import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const KEYS = ['HALF_SHELL_MAX_RELATED_FILES', 'HALF_SHELL_MAX_RELATED_LOOKUPS'];

describe('related-context settings', () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('uses the documented default when unset', () => {
    expect(loadConfig().review.maxRelatedFiles).toBe(5);
  });

  it('honours 0 as the documented way to disable related context', () => {
    process.env['HALF_SHELL_MAX_RELATED_FILES'] = '0';
    expect(loadConfig().review.maxRelatedFiles).toBe(0);
  });

  it('falls back rather than yielding NaN on a malformed value', () => {
    // NaN would make every bound in related.ts a false comparison, removing
    // the cap instead of restoring it.
    for (const bad of ['five', '', 'off', '5 files']) {
      process.env['HALF_SHELL_MAX_RELATED_FILES'] = bad;
      const value = loadConfig().review.maxRelatedFiles;
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(5);
    }
  });

  it('bounds the lookup budget the same way', () => {
    process.env['HALF_SHELL_MAX_RELATED_LOOKUPS'] = 'lots';
    expect(loadConfig().review.maxRelatedLookups).toBe(30);

    process.env['HALF_SHELL_MAX_RELATED_LOOKUPS'] = '0';
    expect(loadConfig().review.maxRelatedLookups).toBe(0);
  });
});

describe('review engine selection', () => {
  afterEach(() => {
    delete process.env['HALF_SHELL_REVIEW_ENGINE'];
  });

  it('defaults to v1 when unset, preserving current production behavior', () => {
    expect(loadConfig().reviewEngine).toBe('v1');
  });

  it('honours an explicit v1 or council selection', () => {
    process.env['HALF_SHELL_REVIEW_ENGINE'] = 'v1';
    expect(loadConfig().reviewEngine).toBe('v1');

    process.env['HALF_SHELL_REVIEW_ENGINE'] = 'council';
    expect(loadConfig().reviewEngine).toBe('council');
  });

  it('fails loudly on an invalid engine rather than silently falling back', () => {
    process.env['HALF_SHELL_REVIEW_ENGINE'] = 'turtle-power';
    expect(() => loadConfig()).toThrow(/HALF_SHELL_REVIEW_ENGINE/);
  });
});
