/**
 * MENTORSHIP (Issue #12 section 6). Splinter receives the candidate
 * findings plus bounded historical context and looks for recurring
 * patterns. History is a lens, never proof — a prior finding can justify
 * closer inspection, it never substitutes for current evidence, and an
 * isolated defect is not inflated into a "pattern" without an actual prior
 * match to point to.
 *
 * Runs after INDEPENDENT_REVIEW's raw output has already been persisted as
 * candidate CouncilFinding rows (stable ids assigned), and before
 * SYNTHESIS groups them — so lessons attach directly to a finding's own
 * historicalContext field rather than needing a separate side channel.
 */
import { log, errorFields } from '../../logger.js';
import type { PersonaConfig } from '../../personas/types.js';
import { parseJsonObject } from '../../providers/json.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import type { CouncilFinding } from '../types.js';

const INSTRUCTION = [
  'Phase: MENTORSHIP. You are given the candidate findings from this run and',
  'bounded historical context (prior findings, prior resolutions, repository',
  'guidance, recurrence metadata). History teaches you where to look. It',
  'does not prove the current finding — an isolated one-off stays isolated',
  'unless you can point to an actual prior match.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "lessons": [',
  '    {"finding_index": 0, "recurring": true, "prior_finding_ids": ["..."], "lesson": "..."}',
  '  ],',
  '  "guardrail_recommendations": ["a reusable prevention mechanism worth Leo considering"]',
  '}',
  '',
  'finding_index refers to the position (0-based) of a finding in the',
  'candidate list you were given. Only include a lesson entry for a finding',
  'you actually have historical evidence about — most findings will have none.',
].join('\n');

export interface MentorshipLesson {
  findingIndex: number;
  recurring: boolean;
  priorFindingIds: string[];
  lesson: string;
}

export interface MentorshipResult {
  ok: boolean;
  lessons: MentorshipLesson[];
  guardrailRecommendations: string[];
  error?: string;
}

/**
 * Applies Splinter's lessons onto the candidate findings they refer to.
 * Findings are addressed by their position in the list handed to the
 * model, since that's the cheapest stable reference across one call —
 * their real ids are already assigned and untouched by this step.
 */
export function applyLessons(findings: CouncilFinding[], lessons: MentorshipLesson[]): CouncilFinding[] {
  const byIndex = new Map(lessons.map((lesson) => [lesson.findingIndex, lesson]));
  return findings.map((finding, index) => {
    const lesson = byIndex.get(index);
    if (!lesson) return finding;
    return {
      ...finding,
      historicalContext: {
        recurring: lesson.recurring,
        priorFindingIds: lesson.priorFindingIds,
        lesson: lesson.lesson,
      },
    };
  });
}

/**
 * Splinter's memory must stay "evidence-based and bounded" (Issue #8) —
 * enforced here, not left to whatever the caller happens to pass in.
 */
export const MAX_HISTORICAL_CONTEXT_CHARS = 8_000;

function boundHistoricalContext(text: string): string {
  if (text.length <= MAX_HISTORICAL_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_HISTORICAL_CONTEXT_CHARS)}\n[...history truncated at ${MAX_HISTORICAL_CONTEXT_CHARS} characters]`;
}

export async function runMentorship(
  provider: ModelProvider,
  persona: PersonaConfig,
  candidateFindings: CouncilFinding[],
  historicalContext: string,
): Promise<MentorshipResult> {
  if (candidateFindings.length === 0) {
    return { ok: true, lessons: [], guardrailRecommendations: [] };
  }
  try {
    const userPrompt = [
      'Candidate findings (0-indexed):',
      JSON.stringify(
        candidateFindings.map((f) => ({ claim: f.claim, category: f.category, file: f.affectedCode.file })),
        null,
        2,
      ),
      '',
      'Bounded historical context:',
      boundHistoricalContext(historicalContext),
    ].join('\n');

    const response = await provider.generate({
      persona: 'splinter',
      phase: 'MENTORSHIP',
      systemPrompt: personaSystemPrompt(persona, INSTRUCTION),
      userPrompt,
      json: true,
      temperature: 0.1,
    });
    const parsed = parseJsonObject<{ lessons?: unknown; guardrail_recommendations?: unknown }>(response.text);
    if (!parsed) return { ok: false, lessons: [], guardrailRecommendations: [], error: 'response was not valid JSON' };

    const rawLessons = Array.isArray(parsed.lessons) ? parsed.lessons : [];
    const lessons: MentorshipLesson[] = rawLessons
      .map((item): MentorshipLesson | undefined => {
        if (typeof item !== 'object' || item === null) return undefined;
        const record = item as Record<string, unknown>;
        const findingIndex = Number(record['finding_index']);
        if (!Number.isInteger(findingIndex) || findingIndex < 0 || findingIndex >= candidateFindings.length) {
          return undefined;
        }
        return {
          findingIndex,
          recurring: Boolean(record['recurring']),
          priorFindingIds: Array.isArray(record['prior_finding_ids'])
            ? (record['prior_finding_ids'] as unknown[]).filter((id): id is string => typeof id === 'string')
            : [],
          lesson: typeof record['lesson'] === 'string' ? record['lesson'] : '',
        };
      })
      .filter((lesson): lesson is MentorshipLesson => lesson !== undefined && lesson.lesson !== '');

    const guardrailRecommendations = Array.isArray(parsed.guardrail_recommendations)
      ? (parsed.guardrail_recommendations as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];

    return { ok: true, lessons, guardrailRecommendations };
  } catch (error) {
    log.warn('mentorship phase failed', errorFields(error));
    return {
      ok: false,
      lessons: [],
      guardrailRecommendations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
