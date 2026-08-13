/**
 * CASE_FILE (Issue #12 section 4). April builds the factual record before
 * any specialist reviews the diff. Output is validated directly against
 * evidence-packet.schema.json — this is the one phase whose model output
 * maps onto a persisted schema with no orchestrator transformation in
 * between, so there is nowhere for an inference to quietly become a fact.
 */
import { parseJsonObject } from '../../providers/json.js';
import type { PersonaConfig } from '../../personas/types.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import { validateAgainst } from '../schema.js';
import type { EvidencePacket } from '../types.js';

const INSTRUCTION = [
  'Phase: CASE_FILE. Build the factual record for this change before anyone',
  'else reviews it. Separate what you can prove from what you are inferring',
  'from what you genuinely do not know yet.',
  '',
  'Respond with a single JSON object matching exactly this shape:',
  '{',
  '  "facts": [{"statement": "..."}],',
  '  "sources": [{"kind": "diff|pull_request|linked_issue|comment|repository_guidance|commit_history|related_pull_request", "reference": "..."}],',
  '  "relevance": ["why facts[i] matters, parallel to facts and sources by index"],',
  '  "inferences": [{"statement": "...", "basis": "..."}],',
  '  "unknowns": [{"question": "...", "why_it_matters": "..."}],',
  '  "stated_intent": "what the PR claims to do, exactly as stated — empty string if nothing was stated",',
  '  "unresolved_context": ["anything left open that a specialist should know about"]',
  '}',
  '',
  'facts, sources, and relevance must be the same length and line up by index.',
  'Unknown is a valid, complete answer — never invent intent to make the story feel finished.',
].join('\n');

export interface CaseFileResult {
  ok: boolean;
  packet?: EvidencePacket;
  error?: string;
}

export async function runCaseFile(
  provider: ModelProvider,
  persona: PersonaConfig,
  reviewId: string,
  changeContext: string,
  attempts = 2,
): Promise<CaseFileResult> {
  let lastError = 'no attempts made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await provider.generate({
      persona: 'april',
      phase: 'CASE_FILE',
      systemPrompt: personaSystemPrompt(persona, INSTRUCTION),
      userPrompt: changeContext,
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
      facts: parsed['facts'] ?? [],
      sources: parsed['sources'] ?? [],
      relevance: parsed['relevance'] ?? [],
      inferences: parsed['inferences'] ?? [],
      unknowns: parsed['unknowns'] ?? [],
      stated_intent: parsed['stated_intent'] ?? '',
      unresolved_context: parsed['unresolved_context'] ?? [],
      created_at: new Date().toISOString(),
    };
    const validation = validateAgainst<Record<string, unknown>>('evidence-packet.schema.json', candidate);
    if (validation.valid && validation.value) {
      return { ok: true, packet: fromSchema(validation.value) };
    }
    lastError = validation.errors.join('; ');
  }
  return { ok: false, error: lastError };
}

function fromSchema(value: Record<string, unknown>): EvidencePacket {
  return {
    reviewId: value['review_id'] as string,
    facts: value['facts'] as EvidencePacket['facts'],
    sources: value['sources'] as EvidencePacket['sources'],
    relevance: value['relevance'] as string[],
    inferences: value['inferences'] as EvidencePacket['inferences'],
    unknowns: (value['unknowns'] as { question: string; why_it_matters?: string | null }[]).map((u) => ({
      question: u.question,
      whyItMatters: u.why_it_matters ?? null,
    })),
    statedIntent: value['stated_intent'] as string,
    unresolvedContext: value['unresolved_context'] as string[],
    createdAt: value['created_at'] as string,
  };
}
