import { log, errorFields } from '../logger.js';
import { parseJsonArray } from '../providers/json.js';
import type { ProviderRouter } from '../providers/router.js';
import { validateVerdict } from '../protocol/schema.js';
import {
  PROTOCOL_VERSION,
  SEVERITIES,
  type Finding,
  type Severity,
  type Verdict,
  type VerdictDecision,
  type VerdictDecisionKind,
} from '../protocol/types.js';
import type { PoolItem } from '../types.js';
import { renderBrief, type ChangeBrief } from './briefing.js';
import { LEONARDO } from './personas.js';
import { renderPool } from './pool.js';
import { systemPrompt, untrusted } from './prompt.js';
import { renderCritiques, type CouncilCritique, type ShredderChallenge } from './sparring.js';

const INSTRUCTION = [
  'Phase 6 — The Verdict. You alone authorize publication. Adjudicate every',
  'finding independently. Do not count votes. A finding earns publication only',
  'when the evidence supports the claimed failure path, the problem belongs to',
  'this change, and it survived challenge. Reject speculation, style, and',
  'pre-existing issues. Silence is a valid verdict.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "decisions": [',
  '    {"finding_id": "HS-001", "decision": "PUBLISH|REJECT|MERGE_FINDINGS|DOWNGRADE|UPGRADE|REQUEST_MORE_INVESTIGATION",',
  '     "reasoning": "why", "severity": "critical|high|medium|low or null", "merge_into": "finding id or null"}',
  '  ],',
  '  "unresolved_uncertainty": ["anything the council could not settle"]',
  '}',
  '',
  'Every pooled finding must appear exactly once in "decisions".',
  'Use "severity" only with DOWNGRADE or UPGRADE; those findings are published',
  'at the adjusted severity.',
].join('\n');

const DECISIONS = new Set<VerdictDecisionKind>([
  'PUBLISH',
  'REJECT',
  'MERGE_FINDINGS',
  'DOWNGRADE',
  'UPGRADE',
  'REQUEST_MORE_INVESTIGATION',
]);

export interface AdjudicationInput {
  pool: PoolItem[];
  brief: ChangeBrief;
  critiques: CouncilCritique[];
  shredder: ShredderChallenge;
  coverage: string;
  coverageLimitations: string[];
}

export interface Adjudication {
  ok: boolean;
  decisions: VerdictDecision[];
  unresolvedUncertainty: string[];
}

/** Phase 6: Leonardo receives the full record and decides. */
export async function runVerdict(
  router: ProviderRouter,
  input: AdjudicationInput,
): Promise<Adjudication> {
  if (input.pool.length === 0) {
    return { ok: true, decisions: [], unresolvedUncertainty: [] };
  }

  const user = [
    renderBrief(input.brief),
    '',
    `Review coverage: ${input.coverage}`,
    input.coverageLimitations.length > 0
      ? `Coverage limitations: ${input.coverageLimitations.join('; ')}`
      : 'Coverage limitations: none.',
    '',
    untrusted('anonymous_finding_pool', renderPool(input.pool)),
    '',
    untrusted('council_critiques', renderCritiques(input.critiques)),
    '',
    untrusted(
      'shredder_challenge',
      [
        input.shredder.changeChallenge || 'No challenge to the change itself was recorded.',
        '',
        renderCritiques(input.shredder.critiques),
      ].join('\n'),
    ),
  ].join('\n');

  try {
    const result = await router.complete({
      system: systemPrompt(LEONARDO, INSTRUCTION),
      user,
      json: true,
      temperature: 0,
    });
    const decisions = parseDecisions(result.text, input.pool);
    const uncertainty = parseJsonArray<string>(result.text, ['unresolved_uncertainty']).filter(
      (entry): entry is string => typeof entry === 'string',
    );
    // Partial adjudication is a failed phase, not a licence to publish the
    // subset that happened to parse: every pooled finding needs a decision.
    const ok = decisions.length === input.pool.length;
    if (!ok) {
      log.error('adjudication did not cover the pool', {
        pooled: input.pool.length,
        decided: decisions.length,
      });
    }
    return { ok, decisions, unresolvedUncertainty: uncertainty };
  } catch (error) {
    log.error('verdict phase failed', errorFields(error));
    return { ok: false, decisions: [], unresolvedUncertainty: [] };
  }
}

function parseDecisions(raw: string, pool: PoolItem[]): VerdictDecision[] {
  const known = new Set(pool.map((item) => item.finding.finding_id));
  const items = parseJsonArray<Record<string, unknown>>(raw, ['decisions']);
  const decisions: VerdictDecision[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const findingId = String(item['finding_id'] ?? '');
    const decision = String(item['decision'] ?? '').toUpperCase() as VerdictDecisionKind;
    if (!known.has(findingId) || seen.has(findingId) || !DECISIONS.has(decision)) continue;
    const severity = String(item['severity'] ?? '').toLowerCase() as Severity;
    seen.add(findingId);
    decisions.push({
      finding_id: findingId,
      decision,
      reasoning: typeof item['reasoning'] === 'string' ? item['reasoning'].trim() : '',
      severity: SEVERITIES.includes(severity) ? severity : null,
      merge_into: typeof item['merge_into'] === 'string' ? item['merge_into'] : null,
    });
  }
  return decisions;
}

export interface VerdictAssembly {
  verdict: Verdict;
  /** Reasoning per published finding, used when rendering the review body. */
  rationale: Map<string, string>;
}

/**
 * Folds Leonardo's decisions into the published verdict. Anything Leonardo did
 * not explicitly approve stays inside The Dojo.
 */
export function assembleVerdict(params: {
  pool: PoolItem[];
  adjudication: Adjudication;
  reviewedSha: string;
  baseSha: string;
  coverage: string;
  coverageLimitations: string[];
  laneFailures: number;
  /** Sparring or Shredder passes that could not run. */
  challengeFailures: number;
}): VerdictAssembly {
  const { pool, adjudication } = params;
  const byId = new Map(pool.map((item) => [item.finding.finding_id, item.finding]));
  const decisionById = new Map(adjudication.decisions.map((d) => [d.finding_id, d]));

  const published: Finding[] = [];
  const rationale = new Map<string, string>();
  const uncertainty = [...adjudication.unresolvedUncertainty];

  for (const item of pool) {
    const finding = item.finding;
    const decision = decisionById.get(finding.finding_id);
    if (!decision) continue;

    switch (decision.decision) {
      case 'PUBLISH':
        published.push(finding);
        rationale.set(finding.finding_id, decision.reasoning);
        break;
      case 'DOWNGRADE':
      case 'UPGRADE': {
        const severity = decision.severity ?? finding.severity;
        published.push({ ...finding, severity });
        rationale.set(finding.finding_id, decision.reasoning);
        break;
      }
      case 'MERGE_FINDINGS': {
        const target = decision.merge_into ? byId.get(decision.merge_into) : undefined;
        if (target) {
          target.corroboration_count += 1;
          target.corroborating_evidence = [
            ...new Set([...(target.corroborating_evidence ?? []), finding.evidence]),
          ];
        }
        break;
      }
      case 'REQUEST_MORE_INVESTIGATION':
        uncertainty.push(`${finding.file}: ${finding.claim} (${decision.reasoning})`);
        break;
      case 'REJECT':
        break;
    }
  }

  const unadjudicated = pool.length - decisionById.size;
  if (unadjudicated > 0) {
    uncertainty.push(`${unadjudicated} pooled finding(s) received no adjudication and were withheld.`);
  }

  const limitations = [...params.coverageLimitations];
  if (!adjudication.ok) limitations.push('Adjudication failed; no findings were published.');

  const verdict: Verdict = {
    protocol_version: PROTOCOL_VERSION,
    reviewed_sha: params.reviewedSha,
    base_sha: params.baseSha,
    coverage: params.coverage,
    candidate_count: pool.length,
    rejected_count: Math.max(pool.length - published.length, 0),
    published_findings: adjudication.ok ? published : [],
    unresolved_uncertainty: uncertainty,
    coverage_limitations: limitations,
    // Rule 12: a clean verdict requires that meaningful review actually ran —
    // investigation, challenge, and adjudication alike.
    complete: adjudication.ok && params.laneFailures === 0 && params.challengeFailures === 0,
  };

  const validation = validateVerdict(verdict);
  if (!validation.valid) {
    log.error('assembled verdict failed schema validation', { errors: validation.errors });
    verdict.complete = false;
    verdict.published_findings = [];
  }

  return { verdict, rationale };
}
