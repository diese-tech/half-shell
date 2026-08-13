import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateAgainst, type SchemaName } from './schema.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'schemas', 'fixtures');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

describe('orchestration schemas', () => {
  it.each<[SchemaName, string]>([
    ['review-run.schema.json', 'review-run.json'],
    ['finding.schema.json', 'finding.json'],
    ['evidence-packet.schema.json', 'evidence-packet.json'],
    ['council-event.schema.json', 'council-event.json'],
    ['verdict.schema.json', 'verdict.json'],
  ])('validates the %s fixture', (schema, fixtureFile) => {
    const { valid, errors } = validateAgainst(schema, fixture(fixtureFile));
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a review-run missing a required field', () => {
    const broken = fixture('review-run.json') as Record<string, unknown>;
    delete broken['head_sha'];
    const { valid, errors } = validateAgainst('review-run.schema.json', broken);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('head_sha'))).toBe(true);
  });

  it('rejects a finding whose source_persona is not a real persona', () => {
    const broken = { ...(fixture('finding.json') as Record<string, unknown>), source_persona: 'bebop' };
    const { valid } = validateAgainst('finding.schema.json', broken);
    expect(valid).toBe(false);
  });

  it('rejects a council event with a non-monotonic-looking sequence type', () => {
    const broken = { ...(fixture('council-event.json') as Record<string, unknown>), sequence: 'first' };
    const { valid } = validateAgainst('council-event.schema.json', broken);
    expect(valid).toBe(false);
  });

  it('requires the verdict reviewer to be literally "leonardo"', () => {
    const broken = { ...(fixture('verdict.json') as Record<string, unknown>), reviewer: 'raph' };
    const { valid } = validateAgainst('verdict.schema.json', broken);
    expect(valid).toBe(false);
  });

  it('rejects an evidence packet whose fact lacks a source-array counterpart shape mismatch is still just a type check, not cross-field', () => {
    // Schema-level validation cannot enforce facts/sources/relevance parallel
    // arrays being the same length — that is a runtime invariant, checked in
    // the CASE_FILE phase itself (see phases/caseFile.ts), not the schema.
    const packet = fixture('evidence-packet.json') as Record<string, unknown>;
    const { valid } = validateAgainst('evidence-packet.schema.json', packet);
    expect(valid).toBe(true);
  });
});
