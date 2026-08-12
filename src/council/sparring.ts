import { log, errorFields } from '../logger.js';
import { parseJsonArray } from '../providers/json.js';
import type { ProviderRouter } from '../providers/router.js';
import { keepValid, validateCritique } from '../protocol/schema.js';
import type { Critique } from '../protocol/types.js';
import type { PoolItem } from '../types.js';
import { renderBrief, type ChangeBrief } from './briefing.js';
import { INVESTIGATORS, SHREDDER, type Persona } from './personas.js';
import { renderPool } from './pool.js';
import { systemPrompt, untrusted } from './prompt.js';

const SPARRING_INSTRUCTION = [
  'Phase 4 — Sparring. The findings below are anonymous. Do not guess who',
  'raised them; authorship is not evidence. Address only claims and evidence.',
  'Silence about a finding is acceptable. Do not critique every finding out of',
  'obligation, and do not raise new findings here.',
  '',
  'Respond with a single JSON object: {"critiques": [...]} where each critique is:',
  '{',
  '  "finding_id": "HS-001",',
  '  "action": "SUPPORT|CHALLENGE|ADD_EVIDENCE|LOWER_SEVERITY|RAISE_SEVERITY|MARK_DUPLICATE|REQUEST_INVESTIGATION",',
  '  "reasoning": "why, grounded in the change",',
  '  "evidence": "supporting evidence or null",',
  '  "suggested_severity": "critical|high|medium|low or null",',
  '  "duplicate_of": "finding id or null"',
  '}',
].join('\n');

const SHREDDER_INSTRUCTION = [
  'Phase 5 — Shredder Challenge. Apply your anti-change prior to the pull',
  'request itself and to every surviving finding. Assume each is unnecessary or',
  'unsafe until the evidence proves otherwise. Attack attribution: if the',
  'behavior predates this change, say so. Attack over-engineered fixes. You',
  'have no veto — your objections are evidence for Leonardo, not a decision.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "change_challenge": "your challenge to the necessity and safety of the PR itself",',
  '  "critiques": [ { "finding_id": "...", "action": "...", "reasoning": "...", "evidence": null, "suggested_severity": null, "duplicate_of": null } ]',
  '}',
].join('\n');

export interface CouncilCritique extends Critique {
  /** Retained for the run record; never shown to other council members. */
  author: string;
}

export interface SparringResult {
  critiques: CouncilCritique[];
  /** Council members whose critique pass never ran; affects coverage. */
  failedRoles: string[];
}

/** Phase 4: every council member may evaluate every pooled finding. */
export async function runSparring(
  router: ProviderRouter,
  pool: PoolItem[],
  brief: ChangeBrief,
): Promise<SparringResult> {
  if (pool.length === 0) return { critiques: [], failedRoles: [] };

  const user = [
    renderBrief(brief),
    '',
    untrusted('anonymous_finding_pool', renderPool(pool)),
  ].join('\n');

  const rounds = await Promise.all(
    INVESTIGATORS.map((persona) => critiquePass(router, persona, SPARRING_INSTRUCTION, user)),
  );

  const validIds = new Set(pool.map((item) => item.finding.finding_id));
  return {
    critiques: rounds
      .flatMap((round) => round.critiques)
      .filter((critique) => validIds.has(critique.finding_id)),
    failedRoles: rounds.filter((round) => !round.ok).map((round) => round.role),
  };
}

export interface ShredderChallenge {
  changeChallenge: string;
  critiques: CouncilCritique[];
  /** False when the adversarial pass could not run at all. */
  ok: boolean;
}

/** Phase 5: a dedicated adversarial pass after ordinary peer critique. */
export async function runShredder(
  router: ProviderRouter,
  pool: PoolItem[],
  brief: ChangeBrief,
  sparring: CouncilCritique[],
): Promise<ShredderChallenge> {
  const user = [
    renderBrief(brief),
    '',
    untrusted('anonymous_finding_pool', renderPool(pool)),
    '',
    untrusted('council_critiques', renderCritiques(sparring)),
  ].join('\n');

  try {
    const result = await router.complete({
      system: systemPrompt(SHREDDER, SHREDDER_INSTRUCTION),
      user,
      json: true,
      temperature: 0.1,
    });
    const critiques = extractCritiques(result.text, SHREDDER);
    const validIds = new Set(pool.map((item) => item.finding.finding_id));
    const challenge =
      /"change_challenge"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(result.text)?.[1]?.replace(/\\"/g, '"') ??
      '';
    return {
      changeChallenge: challenge,
      critiques: critiques.filter((critique) => validIds.has(critique.finding_id)),
      ok: true,
    };
  } catch (error) {
    log.warn('shredder challenge failed', errorFields(error));
    return { changeChallenge: '', critiques: [], ok: false };
  }
}

interface CritiquePassResult {
  role: string;
  ok: boolean;
  critiques: CouncilCritique[];
}

async function critiquePass(
  router: ProviderRouter,
  persona: Persona,
  instruction: string,
  user: string,
): Promise<CritiquePassResult> {
  try {
    const result = await router.complete({
      system: systemPrompt(persona, instruction),
      user,
      json: true,
      temperature: 0.1,
    });
    return { role: persona.id, ok: true, critiques: extractCritiques(result.text, persona) };
  } catch (error) {
    log.warn('sparring pass failed', { role: persona.id, ...errorFields(error) });
    return { role: persona.id, ok: false, critiques: [] };
  }
}

function extractCritiques(raw: string, persona: Persona): CouncilCritique[] {
  const items = parseJsonArray<Record<string, unknown>>(raw, ['critiques']);
  const normalized = items.map((item) => ({
    finding_id: String(item['finding_id'] ?? ''),
    action: item['action'],
    reasoning: typeof item['reasoning'] === 'string' ? item['reasoning'].trim() : '',
    evidence: typeof item['evidence'] === 'string' ? item['evidence'] : null,
    suggested_severity:
      typeof item['suggested_severity'] === 'string' ? item['suggested_severity'] : null,
    duplicate_of: typeof item['duplicate_of'] === 'string' ? item['duplicate_of'] : null,
  }));

  const { kept, rejected } = keepValid<Critique>(normalized, validateCritique);
  if (rejected.length > 0) {
    log.debug('discarded malformed critiques', { role: persona.id, count: rejected.length });
  }
  return kept.map((critique) => ({ ...critique, author: persona.name }));
}

/** Critiques are shown to later phases without their authors. */
export function renderCritiques(critiques: CouncilCritique[]): string {
  if (critiques.length === 0) return 'No critiques were recorded.';
  return critiques
    .map((critique) =>
      [
        `${critique.finding_id} — ${critique.action}`,
        `Reasoning: ${critique.reasoning}`,
        ...(critique.evidence ? [`Evidence: ${critique.evidence}`] : []),
        ...(critique.suggested_severity
          ? [`Suggested severity: ${critique.suggested_severity}`]
          : []),
        ...(critique.duplicate_of ? [`Duplicate of: ${critique.duplicate_of}`] : []),
      ].join('\n'),
    )
    .join('\n\n');
}
