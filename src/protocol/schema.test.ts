import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { protocolDir } from './protocol.js';
import { validateCritique, validateFinding, validateResolution, validateVerdict } from './schema.js';

describe('protocol schemas', () => {
  it('accepts the bundled sample verdict', () => {
    const sample = JSON.parse(
      readFileSync(join(protocolDir(), 'examples', 'sample-verdict.json'), 'utf8'),
    );
    const result = validateVerdict(sample);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a finding with an unknown category', () => {
    const result = validateFinding({
      finding_id: 'HS-001',
      severity: 'high',
      confidence: 0.9,
      category: 'vibes',
      file: 'src/a.ts',
      claim: 'c',
      evidence: 'e',
      failure_mode: 'f',
      suggested_fix: 's',
      corroboration_count: 1,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    const result = validateFinding({
      finding_id: 'HS-001',
      severity: 'high',
      confidence: 4,
      category: 'bug',
      file: 'src/a.ts',
      claim: 'c',
      evidence: 'e',
      failure_mode: 'f',
      suggested_fix: 's',
      corroboration_count: 1,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a critique action outside the protocol', () => {
    expect(
      validateCritique({ finding_id: 'HS-001', action: 'VETO', reasoning: 'because' }).valid,
    ).toBe(false);
  });

  it('accepts every documented resolution status', () => {
    for (const status of [
      'RESOLVED',
      'STILL_VALID',
      'PARTIALLY_RESOLVED',
      'WITHDRAWN',
      'NEEDS_MORE_EVIDENCE',
    ]) {
      expect(validateResolution({ finding_id: 'HS-001', status, reasoning: 'r' }).valid).toBe(true);
    }
  });

  it('rejects a verdict claiming a different protocol version', () => {
    expect(
      validateVerdict({
        protocol_version: '2.0.0',
        reviewed_sha: 'abcdef1',
        coverage: 'all',
        candidate_count: 0,
        rejected_count: 0,
        published_findings: [],
        complete: true,
      }).valid,
    ).toBe(false);
  });
});
