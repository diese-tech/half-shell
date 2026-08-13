/**
 * LEO_REVIEW (Issue #12 section 10). Leo receives the surviving findings,
 * evidence, Sparring history, and corroboration metadata, and returns a
 * structured verdict validated against verdict.schema.json. He does not
 * count votes — that discipline lives in the prompt (config/personas/
 * leonardo.yaml), but every finding's outcome and reasoning is
 * machine-validated regardless of what the prompt achieves.
 */
import { parseJsonObject } from '../../providers/json.js';
import type { PersonaConfig } from '../../personas/types.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import { validateAgainst } from '../schema.js';
import type { CouncilFinding, Verdict } from '../types.js';

const INSTRUCTION = [
  'Phase: LEO_REVIEW. You have the findings that survived Sparring. Decide,',
  'per finding, what happens to it — and record your reasoning, because a',
  'rejection or severity change without reasoning is not a valid verdict.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "overall_outcome": "clean_review|non_blocking_findings_published|blocking_findings_published|incomplete",',
  '  "rationale": "one or two sentences, plain English",',
  '  "findings": [',
  '    {',
  '      "finding_id": "...",',
  '      "outcome": "publish|reject|merge|narrow|raise_severity|lower_severity|request_more_investigation",',
  '      "final_severity": "critical|high|medium|low|null",',
  '      "public_reason": "plain-English reason, safe to publish as-is"',
  '    }',
  '  ],',
  '  "unresolved_uncertainty": ["material unknowns left over, if any"]',
  '}',
].join('\n');

export interface LeoReviewResult {
  ok: boolean;
  verdict?: Verdict;
  error?: string;
}

export async function runLeoReview(
  provider: ModelProvider,
  persona: PersonaConfig,
  reviewId: string,
  survivingFindings: CouncilFinding[],
  sparringHistory: string,
  attempts = 2,
): Promise<LeoReviewResult> {
  let lastError = 'no attempts made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await provider.generate({
      persona: 'leo',
      phase: 'LEO_REVIEW',
      systemPrompt: personaSystemPrompt(persona, INSTRUCTION),
      userPrompt: [
        `Surviving findings: ${JSON.stringify(survivingFindings)}`,
        '',
        `Sparring history: ${sparringHistory}`,
      ].join('\n'),
      json: true,
      temperature: 0.1,
    });
    const parsed = parseJsonObject<Record<string, unknown>>(response.text);
    if (!parsed) {
      lastError = 'response was not valid JSON';
      continue;
    }
    const candidate = {
      review_id: reviewId,
      reviewer: 'leonardo',
      overall_outcome: parsed['overall_outcome'],
      rationale: parsed['rationale'],
      findings: parsed['findings'] ?? [],
      unresolved_uncertainty: parsed['unresolved_uncertainty'] ?? [],
      created_at: new Date().toISOString(),
    };
    const validation = validateAgainst<Record<string, unknown>>('verdict.schema.json', candidate);
    if (validation.valid && validation.value) {
      return { ok: true, verdict: fromSchema(validation.value) };
    }
    lastError = validation.errors.join('; ');
  }
  return { ok: false, error: lastError };
}

function fromSchema(value: Record<string, unknown>): Verdict {
  const findings = value['findings'] as {
    finding_id: string;
    outcome: Verdict['findings'][number]['outcome'];
    final_severity: Verdict['findings'][number]['finalSeverity'];
    public_reason: string;
  }[];
  return {
    reviewId: value['review_id'] as string,
    reviewer: 'leonardo',
    overallOutcome: value['overall_outcome'] as Verdict['overallOutcome'],
    rationale: value['rationale'] as string,
    findings: findings.map((f) => ({
      findingId: f.finding_id,
      outcome: f.outcome,
      finalSeverity: f.final_severity,
      publicReason: f.public_reason,
    })),
    unresolvedUncertainty: value['unresolved_uncertainty'] as string[],
    createdAt: value['created_at'] as string,
  };
}
