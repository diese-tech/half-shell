/**
 * INDEPENDENT_REVIEW (Issue #12 section 5). Raph, Donnie, Mikey, and Casey
 * run in parallel and never see each other's output during this phase —
 * each gets the same change context and nothing else, so a shared
 * conclusion later in Synthesis is genuine independent corroboration, not
 * anchoring. A lane that fails is reported as missing, never silently
 * folded into "reviewed, found nothing."
 */
import { log, errorFields } from '../../logger.js';
import type { PersonaConfig } from '../../personas/types.js';
import { parseJsonObject } from '../../providers/json.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import { groundQuote, parseChangedFiles, withQuote, type ChangedFiles, type DropReason } from '../grounding.js';
import type { RawFinding } from '../synthesis.js';
import type { FindingCategory, PersonaCodename } from '../types.js';

export const INDEPENDENT_REVIEWERS: PersonaCodename[] = ['raph', 'donnie', 'mikey', 'casey'];

const INSTRUCTION = [
  'Phase: INDEPENDENT_REVIEW. You cannot see any other reviewer\'s findings —',
  'this is your own independent pass. Report only what your lane actually',
  'covers. An empty array is the correct answer when you found nothing.',
  '',
  'Respond with a single JSON object: {"findings": [...]} where each finding is:',
  '{',
  '  "category": "bug|regression|security|contract|incomplete_change|missing_test|undocumented_behavior|operational|human_experience|operational_abuse|engineering_discipline",',
  '  "claim": "one sentence stating the defect",',
  '  "evidence": "what in the diff or context proves it",',
  '  "quote": "one line copied exactly from the changed file you name below, at or near the line you give",',
  '  "file": "path exactly as shown in the diff",',
  '  "line": head-side line number, or null,',
  '  "consequence": "the concrete way this fails at runtime or in practice",',
  '  "confidence": 0.0-1.0,',
  '  "proposed_fix": "the smallest correction that resolves it, or null",',
  '  "root_cause": "why it happens, or null if only the symptom is known"',
  '}',
].join('\n');

/** A finding refused before it became a candidate (malformed, or by the provenance gate), kept on the record — never reviewed further. */
export interface DroppedFinding {
  persona: PersonaCodename;
  claim: string;
  file: string;
  line: number | null;
  quote: string;
  reason: DropReason | 'malformed_finding';
  detail: string;
}

export interface LaneOutcome {
  persona: PersonaCodename;
  ok: boolean;
  findings: RawFinding[];
  dropped: DroppedFinding[];
  error?: string;
}

export async function runIndependentReview(
  providerFor: (persona: PersonaCodename) => ModelProvider,
  personaFor: (persona: PersonaCodename) => PersonaConfig,
  changeContext: string,
): Promise<LaneOutcome[]> {
  return Promise.all(INDEPENDENT_REVIEWERS.map((persona) => runLane(providerFor(persona), personaFor(persona), changeContext)));
}

async function runLane(
  provider: ModelProvider,
  persona: PersonaConfig,
  changeContext: string,
  attempts = 2,
): Promise<LaneOutcome> {
  const codename = persona.codename as PersonaCodename;
  let lastError = 'no attempts made';
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await provider.generate({
        persona: codename,
        phase: 'INDEPENDENT_REVIEW',
        systemPrompt: personaSystemPrompt(persona, INSTRUCTION),
        userPrompt: changeContext,
        json: true,
        temperature: 0.15,
      });
      // parseJsonObject returning undefined means the response genuinely
      // did not parse — distinct from a well-formed {"findings": []},
      // which is a legitimate clean result and must not be retried or
      // treated as a failure.
      const parsed = parseJsonObject<Record<string, unknown>>(response.text);
      if (!parsed) {
        lastError = 'response was not valid JSON';
        continue;
      }
      // Only an actual `findings` array is a result. `{}` or a non-array is
      // not "found nothing" — it's invalid output, retried and ultimately a
      // missing lane, never a clean pass.
      if (!Array.isArray(parsed['findings'])) {
        lastError = 'response had no findings array';
        continue;
      }
      const raw: unknown[] = parsed['findings'];
      const files = parseChangedFiles(changeContext);
      const results = raw.map((item) => normalize(item, codename, files));
      const findings = results.flatMap((result) => ('finding' in result ? [result.finding] : []));
      const dropped = results.flatMap((result) => ('dropped' in result ? [result.dropped] : []));
      if (dropped.length > 0) {
        log.info('independent review findings dropped', { persona: codename, kept: findings.length, dropped: dropped.length });
      }
      return { persona: codename, ok: true, findings, dropped };
    }
    log.warn('independent review lane failed validation after retries', { persona: codename, error: lastError });
    return { persona: codename, ok: false, findings: [], dropped: [], error: lastError };
  } catch (error) {
    log.warn('independent review lane failed', { persona: codename, ...errorFields(error) });
    return {
      persona: codename,
      ok: false,
      findings: [],
      dropped: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const CATEGORIES = new Set<FindingCategory>([
  'bug',
  'regression',
  'security',
  'contract',
  'incomplete_change',
  'missing_test',
  'undocumented_behavior',
  'operational',
  'human_experience',
  'operational_abuse',
  'engineering_discipline',
]);

// Severity is not modeled here — only Leo assigns it, in LEO_REVIEW.
// Every item either becomes a finding or is dropped with a reason — a
// malformed one included, so discarded model output is never invisible
// (a review that discarded output must not take the clean early exit).
function normalize(
  value: unknown,
  persona: PersonaCodename,
  files: ChangedFiles,
): { finding: RawFinding } | { dropped: DroppedFinding } {
  const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const category = String(item['category'] ?? '').toLowerCase() as FindingCategory;
  const file = typeof item['file'] === 'string' ? item['file'].trim() : '';
  const text = (key: string): string => (typeof item[key] === 'string' ? (item[key] as string).trim() : '');
  const claim = text('claim');
  const evidence = text('evidence');
  const consequence = text('consequence');

  if (!CATEGORIES.has(category) || !file || !claim || !evidence || !consequence) {
    const missing = ['category', 'file', 'claim', 'evidence', 'consequence'].filter((key) =>
      key === 'category' ? !CATEGORIES.has(category) : key === 'file' ? !file : !text(key),
    );
    return {
      dropped: { persona, claim, file, line: null, quote: text('quote'), reason: 'malformed_finding', detail: `missing or invalid: ${missing.join(', ')}` },
    };
  }

  const confidence = Number(item['confidence']);
  const rawLine = Number(item['line']);
  const line = Number.isInteger(rawLine) && rawLine >= 1 ? rawLine : null;
  const quote = text('quote');
  const grounding = groundQuote(files, { file, line, quote });
  if (!grounding.ok) return { dropped: { persona, claim, file, line, quote, reason: grounding.reason, detail: grounding.detail } };

  return { finding: {
    sourcePersona: persona,
    category,
    claim,
    // Carried into Sparring and Leo's view, so the line can also refute the claim.
    evidence: withQuote(evidence, quote),
    affectedCode: {
      file,
      line,
      startLine: null,
    },
    consequence,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    proposedFix: typeof item['proposed_fix'] === 'string' ? item['proposed_fix'] : null,
    rootCause: typeof item['root_cause'] === 'string' ? item['root_cause'] : null,
  } };
}
