import { describe, expect, it } from 'vitest';

import { anonymize, synthesize, toCandidate } from './synthesis.js';
import type { RawFinding } from './synthesis.js';

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    sourcePersona: 'raph',
    category: 'regression',
    claim: 'importRecords still calls load() without the tenant id.',
    evidence: 'load() gained a required tenantId parameter but this call site passes only id.',
    affectedCode: { file: 'src/import.ts', line: 12, startLine: null },
    consequence: 'Every import throws at runtime.',
    confidence: 0.8,
    ...overrides,
  };
}

describe('synthesize — deduplication with preserved provenance', () => {
  it('collapses literal duplicates into one canonical finding, marking the rest merged with a link to it', () => {
    const a = toCandidate('rev_1', raw({ sourcePersona: 'raph' }));
    const b = toCandidate('rev_1', raw({ sourcePersona: 'mikey' }));

    const result = synthesize([a, b]);

    const canonical = result.find((f) => f.status !== 'merged');
    const merged = result.find((f) => f.status === 'merged');
    expect(canonical).toBeDefined();
    expect(merged).toBeDefined();
    // a (raph) was submitted first, so it stays canonical; b (mikey) merges
    // into it — but provenance survives on the merged record either way.
    expect(canonical?.id).toBe(a.id);
    expect(merged?.id).toBe(b.id);
    expect(merged?.sourcePersona).toBe('mikey');
    expect(merged?.relatedFindings).toEqual([canonical?.id]);
  });

  it('records who corroborated a collapsed duplicate', () => {
    const a = toCandidate('rev_1', raw({ sourcePersona: 'raph' }));
    const b = toCandidate('rev_1', raw({ sourcePersona: 'mikey' }));
    const [canonical] = synthesize([a, b]).filter((f) => f.status !== 'merged');
    expect(canonical?.corroboration?.contributingSourcePersonas).toEqual(
      expect.arrayContaining(['raph', 'mikey']),
    );
  });

  it('links distinct claims about the same area without collapsing them, preserving each evidence path', () => {
    const raphFinding = toCandidate(
      'rev_1',
      raw({ sourcePersona: 'raph', claim: 'Two requests can write the same row twice.', evidence: 'reproduced a duplicate write' }),
    );
    const donnieFinding = toCandidate(
      'rev_1',
      raw({ sourcePersona: 'donnie', claim: 'The shared counter is not updated atomically.', evidence: 'traced the non-atomic increment' }),
    );

    const result = synthesize([raphFinding, donnieFinding]);

    expect(result).toHaveLength(2);
    expect(result.every((f) => f.status !== 'merged')).toBe(true);
    expect(result[0]?.relatedFindings).toContain(result[1]?.id);
    expect(result[1]?.relatedFindings).toContain(result[0]?.id);
    // Each finding keeps its own evidence — nothing was thrown away.
    expect(result.map((f) => f.evidence)).toEqual(
      expect.arrayContaining(['reproduced a duplicate write', 'traced the non-atomic increment']),
    );
    expect(result.every((f) => f.corroboration?.type === 'independent_distinct_evidence')).toBe(true);
  });

  it('leaves a lone finding untouched', () => {
    const only = toCandidate('rev_1', raw());
    const result = synthesize([only]);
    expect(result).toEqual([only]);
  });

  it('keeps findings about different files or categories entirely separate', () => {
    const a = toCandidate('rev_1', raw({ affectedCode: { file: 'src/a.ts', line: 1, startLine: null } }));
    const b = toCandidate('rev_1', raw({ affectedCode: { file: 'src/b.ts', line: 1, startLine: null } }));
    const result = synthesize([a, b]);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.relatedFindings.length === 0)).toBe(true);
  });
});

describe('anonymize', () => {
  it('strips source_persona from the Sparring-facing view', () => {
    const finding = toCandidate('rev_1', raw());
    const view = anonymize(finding);
    expect(view).not.toHaveProperty('sourcePersona');
    expect(view.id).toBe(finding.id);
  });
});
