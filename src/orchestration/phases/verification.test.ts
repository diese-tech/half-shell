import { describe, expect, it } from 'vitest';

import { parseChangedFiles, withQuote } from '../grounding.js';
import { toCandidate } from '../synthesis.js';
import { GENERATION_3_FIXTURES, type VerifierFixture } from '../testing/generation3.js';
import { minimalPersonaConfig, ScriptedModelProvider, throwingProvider } from '../testing/fakes.js';
import { verificationSubject, verifyFinding } from './verification.js';

const shredder = minimalPersonaConfig({ codename: 'shredder' });

function findingFor(fixture: VerifierFixture, quote = fixture.quote) {
  return toCandidate('rev_1', {
    sourcePersona: 'raph',
    category: 'security',
    claim: fixture.claim,
    evidence: withQuote('model evidence', quote),
    affectedCode: { file: fixture.file, line: fixture.line, startLine: null },
    consequence: 'c',
    confidence: 1,
  });
}

describe('verificationSubject — the verifier sees only claim, file, quote and a bounded excerpt', () => {
  it.each(GENERATION_3_FIXTURES)('builds a bounded subject for: $name', (fixture) => {
    const subject = verificationSubject(findingFor(fixture), parseChangedFiles(fixture.changeContext));
    expect(subject).toMatchObject({ claim: fixture.claim, file: fixture.file, quote: fixture.quote });
    expect(subject!.excerpt).toContain(fixture.quote);
    expect(subject!.excerpt.split('\n').length).toBeLessThanOrEqual(13);
  });

  it('has nothing to verify when the quote is missing or no longer grounds in the claimed file', () => {
    const [fixture] = GENERATION_3_FIXTURES;
    const files = parseChangedFiles(fixture!.changeContext);
    expect(verificationSubject({ ...findingFor(fixture!), evidence: 'no quote' }, files)).toBeUndefined();
    expect(verificationSubject(findingFor(fixture!, 'a line that is not in that file at all'), files)).toBeUndefined();
  });
});

describe('verifyFinding', () => {
  it.each(GENERATION_3_FIXTURES)('returns the verdict for: $name, asking narrowly at temperature 0', async (fixture) => {
    const provider = new ScriptedModelProvider({ 'shredder:SYNTHESIS': () => ({ verdict: fixture.expected.toLowerCase(), reason: 'r' }) });
    const subject = verificationSubject(findingFor(fixture), parseChangedFiles(fixture.changeContext))!;

    expect(await verifyFinding(provider, shredder, subject)).toEqual({ verdict: fixture.expected, reason: 'r' });
    const [call] = provider.calls;
    expect(call).toMatchObject({ persona: 'shredder', phase: 'SYNTHESIS', json: true, temperature: 0 });
    expect(call!.userPrompt).toContain(`Claim: ${fixture.claim}`);
    expect(call!.userPrompt).toContain(`File: ${fixture.file}`);
    expect(call!.userPrompt).not.toContain('Changed files (line numbers are the head-side truth)');
    expect(call!.systemPrompt).toContain('SUPPORTS');
  });

  it('gives no verdict when the provider fails or answers outside the three verdicts', async () => {
    const [fixture] = GENERATION_3_FIXTURES;
    const subject = verificationSubject(findingFor(fixture!), parseChangedFiles(fixture!.changeContext))!;
    expect(await verifyFinding(throwingProvider, shredder, subject)).toBeUndefined();
    const vague = new ScriptedModelProvider({ 'shredder:SYNTHESIS': () => ({ verdict: 'PROBABLY', reason: 'r' }) });
    expect(await verifyFinding(vague, shredder, subject)).toBeUndefined();
  });
});
