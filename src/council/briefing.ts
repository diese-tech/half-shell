import { parseJsonObject } from '../providers/json.js';
import type { ProviderRouter } from '../providers/router.js';
import { log, errorFields } from '../logger.js';
import type { ChangeContext } from '../types.js';
import { BRIEFING_PERSONA } from './personas.js';
import { renderChange, systemPrompt, untrusted, type ContextRenderOptions } from './prompt.js';

export interface ChangeBrief {
  claimed_change: string;
  actual_change: string;
  constraints: string[];
  prior_behavior: string;
  uncertainty: string[];
}

const INSTRUCTION = [
  'Phase 1 — Briefing. Produce a shared factual brief. Do not report issues,',
  'do not speculate, and do not propose fixes. State only what is observable.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "claimed_change": "what the PR says it does",',
  '  "actual_change": "what the diff actually changes, in system terms",',
  '  "constraints": ["requirements or repository rules that apply"],',
  '  "prior_behavior": "relevant behavior before this change",',
  '  "uncertainty": ["context that is missing or could not be verified"]',
  '}',
].join('\n');

/** Phase 1: one shared factual brief, not April's opinion. */
export async function buildBrief(
  router: ProviderRouter,
  context: ChangeContext,
  render: ContextRenderOptions,
): Promise<ChangeBrief> {
  const fallback: ChangeBrief = {
    claimed_change: context.title,
    actual_change: context.files.map((file) => file.path).join(', '),
    constraints: [],
    prior_behavior: 'not established',
    uncertainty: ['Briefing phase failed; investigators worked from the raw diff only.'],
  };

  try {
    const result = await router.complete({
      system: systemPrompt(BRIEFING_PERSONA, INSTRUCTION),
      user: untrusted('github_pull_request', renderChange(context, render)),
      json: true,
      temperature: 0,
    });
    const parsed = parseJsonObject<Partial<ChangeBrief>>(result.text);
    if (!parsed) return fallback;
    return {
      claimed_change: String(parsed.claimed_change ?? fallback.claimed_change),
      actual_change: String(parsed.actual_change ?? fallback.actual_change),
      constraints: toStringArray(parsed.constraints),
      prior_behavior: String(parsed.prior_behavior ?? fallback.prior_behavior),
      uncertainty: toStringArray(parsed.uncertainty),
    };
  } catch (error) {
    log.warn('briefing phase failed', errorFields(error));
    return fallback;
  }
}

export function renderBrief(brief: ChangeBrief): string {
  return [
    'Factual change brief:',
    `- Claimed change: ${brief.claimed_change}`,
    `- Actual change: ${brief.actual_change}`,
    `- Constraints: ${brief.constraints.length ? brief.constraints.join('; ') : 'none recorded'}`,
    `- Prior behavior: ${brief.prior_behavior}`,
    `- Known uncertainty: ${brief.uncertainty.length ? brief.uncertainty.join('; ') : 'none recorded'}`,
  ].join('\n');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
