import { log, errorFields } from '../logger.js';
import { parseJsonArray } from '../providers/json.js';
import type { ProviderRouter } from '../providers/router.js';
import type { Finding, Severity, Category } from '../protocol/types.js';
import { validateFinding } from '../protocol/schema.js';
import type { CandidateFinding, ChangeContext, LaneOutcome, ReviewDepth } from '../types.js';
import { renderBrief, type ChangeBrief } from './briefing.js';
import { INVESTIGATORS, type Persona } from './personas.js';
import { renderChange, systemPrompt, untrusted, type ContextRenderOptions } from './prompt.js';

const LANE_INSTRUCTION = [
  'Phase 2 — Independent lane review. You cannot see any other investigator.',
  'Report only issues inside your lane that this change introduced, exposed,',
  'broke, or failed to update. Cite the head-side line numbers shown in the',
  'diff. An empty array is the correct answer when your lane found nothing.',
  '',
  'Respond with a single JSON object: {"findings": [...]} where each finding is:',
  '{',
  '  "severity": "critical|high|medium|low",',
  '  "confidence": 0.0-1.0,',
  '  "category": "bug|regression|security|contract|incomplete_change|missing_test|undocumented_behavior|operational",',
  '  "file": "path exactly as shown in the diff",',
  '  "line": head-side line number from the diff, or null,',
  '  "claim": "one sentence stating the defect",',
  '  "evidence": "what in the diff or context proves it",',
  '  "failure_mode": "the concrete way this fails at runtime or in practice",',
  '  "suggested_fix": "the smallest correction that resolves it"',
  '}',
].join('\n');

const DEEP_SUFFIX = [
  '',
  'Deep review requested: widen your search within your lane to second-order',
  'consequences and interactions with the surrounding code shown above.',
  'The evidence bar does not move.',
].join('\n');

export interface LaneResult {
  candidates: CandidateFinding[];
  outcomes: LaneOutcome[];
}

/**
 * Phase 2. Lanes run concurrently but never see each other's output, which is
 * what keeps independent duplicate discovery meaningful as corroboration.
 */
export async function runLanes(
  router: ProviderRouter,
  context: ChangeContext,
  brief: ChangeBrief,
  render: ContextRenderOptions,
  depth: ReviewDepth,
): Promise<LaneResult> {
  const change = renderChange(context, render);
  const user = [
    renderBrief(brief),
    '',
    untrusted('github_pull_request', change),
  ].join('\n');

  const settled = await Promise.all(
    INVESTIGATORS.map((persona) => runLane(router, persona, user, depth)),
  );

  return {
    candidates: settled.flatMap((entry) => entry.candidates),
    outcomes: settled.map((entry) => entry.outcome),
  };
}

async function runLane(
  router: ProviderRouter,
  persona: Persona,
  user: string,
  depth: ReviewDepth,
): Promise<{ candidates: CandidateFinding[]; outcome: LaneOutcome }> {
  const instruction = depth === 'deep' ? LANE_INSTRUCTION + DEEP_SUFFIX : LANE_INSTRUCTION;
  try {
    const result = await router.complete({
      system: systemPrompt(persona, instruction),
      user,
      json: true,
      temperature: 0.15,
    });
    const raw = parseJsonArray<Record<string, unknown>>(result.text, ['findings']);
    const candidates: CandidateFinding[] = [];

    raw.forEach((item, index) => {
      const normalized = normalizeFinding(item, persona, index);
      if (!normalized) return;
      const validation = validateFinding(normalized);
      if (!validation.valid || !validation.value) {
        log.debug('discarded malformed finding', {
          role: persona.id,
          errors: validation.errors.slice(0, 3),
        });
        return;
      }
      candidates.push({ finding: validation.value, author: persona.name, provider: result.provider });
    });

    return {
      candidates,
      outcome: {
        role: persona.id,
        ok: true,
        findings: candidates.length,
        provider: result.provider,
      },
    };
  } catch (error) {
    log.warn('lane failed', { role: persona.id, ...errorFields(error) });
    return {
      candidates: [],
      outcome: {
        role: persona.id,
        ok: false,
        findings: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set<Category>([
  'bug',
  'regression',
  'security',
  'contract',
  'incomplete_change',
  'missing_test',
  'undocumented_behavior',
  'operational',
]);

/**
 * The runtime — not the model — owns finding ids and corroboration counts, so
 * identity stays stable through anonymization and merging.
 */
export function normalizeFinding(
  item: Record<string, unknown>,
  persona: Persona,
  index: number,
): Finding | undefined {
  const severity = String(item['severity'] ?? '').toLowerCase() as Severity;
  const category = String(item['category'] ?? '').toLowerCase() as Category;
  const file = typeof item['file'] === 'string' ? item['file'].trim() : '';
  const text = (key: string): string =>
    typeof item[key] === 'string' ? (item[key] as string).trim() : '';

  if (!SEVERITIES.has(severity) || !CATEGORIES.has(category) || !file) return undefined;
  const claim = text('claim');
  const evidence = text('evidence');
  const failureMode = text('failure_mode');
  const suggestedFix = text('suggested_fix');
  if (!claim || !evidence || !failureMode || !suggestedFix) return undefined;

  const confidence = Number(item['confidence']);

  return {
    finding_id: `${persona.id.toUpperCase()}-${String(index + 1).padStart(2, '0')}`,
    severity,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    category,
    file,
    line: toLine(item['line']),
    start_line: toLine(item['start_line']),
    claim,
    evidence,
    failure_mode: failureMode,
    suggested_fix: suggestedFix,
    corroboration_count: 1,
    corroborating_evidence: [],
  };
}

function toLine(value: unknown): number | null {
  const line = Number(value);
  return Number.isInteger(line) && line >= 1 ? line : null;
}
