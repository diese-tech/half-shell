import { describe, expect, it } from 'vitest';

import { toCandidate } from '../synthesis.js';
import { minimalPersonaConfig, ScriptedModelProvider } from '../testing/fakes.js';
import { runLeoReview } from './leoReview.js';

function finding() {
  return toCandidate('rev_1', {
    sourcePersona: 'raph',
    category: 'regression',
    claim: 'a low-value finding',
    evidence: 'weak circumstantial evidence',
    affectedCode: { file: 'src/a.ts', line: 1, startLine: null },
    consequence: 'a minor style inconsistency, technically real but not material',
    confidence: 0.3,
  });
}

describe('runLeoReview', () => {
  it('lets Leo reject a surviving finding that is technically real but not worth publishing, with reasoning recorded', async () => {
    const f = finding();
    const provider = new ScriptedModelProvider({}, () => ({
      overall_outcome: 'clean_review',
      rationale: 'One real but immaterial finding; nothing worth blocking on.',
      findings: [
        {
          finding_id: f.id,
          outcome: 'reject',
          final_severity: null,
          public_reason: 'Technically true, but too minor to justify a review comment.',
        },
      ],
      unresolved_uncertainty: [],
    }));

    const result = await runLeoReview(provider, minimalPersonaConfig({ codename: 'leo' }), 'rev_1', [f], '[]');
    expect(result.ok).toBe(true);
    expect(result.verdict?.findings[0]?.outcome).toBe('reject');
    expect(result.verdict?.findings[0]?.publicReason.length).toBeGreaterThan(0);
  });

  it('rejects a verdict missing required reasoning against the schema', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      overall_outcome: 'clean_review',
      rationale: 'ok',
      findings: [{ finding_id: 'finding_1', outcome: 'reject', final_severity: null }], // no public_reason
      unresolved_uncertainty: [],
    }));
    const result = await runLeoReview(provider, minimalPersonaConfig({ codename: 'leo' }), 'rev_1', [finding()], '[]');
    expect(result.ok).toBe(false);
  });

  it('never counts findings as votes — a single finding can still produce blocking_findings_published', async () => {
    const f = finding();
    const provider = new ScriptedModelProvider({}, () => ({
      overall_outcome: 'blocking_findings_published',
      rationale: 'One strong finding is enough on its own.',
      findings: [{ finding_id: f.id, outcome: 'publish', final_severity: 'high', public_reason: 'This fails on every request.' }],
      unresolved_uncertainty: [],
    }));
    const result = await runLeoReview(provider, minimalPersonaConfig({ codename: 'leo' }), 'rev_1', [f], '[]');
    expect(result.verdict?.overallOutcome).toBe('blocking_findings_published');
  });

  it('forces reviewer to be literally "leonardo" regardless of what the model returns', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      overall_outcome: 'clean_review',
      rationale: 'ok',
      findings: [],
      unresolved_uncertainty: [],
    }));
    const result = await runLeoReview(provider, minimalPersonaConfig({ codename: 'leo' }), 'rev_1', [], '[]');
    expect(result.verdict?.reviewer).toBe('leonardo');
  });
});
