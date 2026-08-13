/**
 * Deterministic test doubles for the orchestration engine — no live LLM
 * calls, no real GitHub. Mirrors the convention already used by
 * src/harness/stub-inference.ts and src/harness/stub-github.ts: shared
 * test infrastructure lives in src, not scattered per test file.
 */
import type { RepoRef } from '../../types.js';
import type { PersonaConfig } from '../../personas/types.js';
import type { ModelProvider, PersonaRequest, PersonaResponse } from '../provider.js';
import type { PublicationGitHubClient } from '../phases/publication.js';
import type { GitHubReviewOutcome, PersonaCodename, Phase } from '../types.js';

export type ScriptedResponder = (request: PersonaRequest) => string | object;

/** Routes each call by (persona, phase) to a scripted response. Falls back to a persona-only script, then a phase-only script, then a default. */
export class ScriptedModelProvider implements ModelProvider {
  public readonly calls: PersonaRequest[] = [];

  constructor(
    private readonly byPersonaAndPhase: Partial<Record<string, ScriptedResponder>> = {},
    private readonly fallback: ScriptedResponder = () => ({ findings: [] }),
  ) {}

  async generate(request: PersonaRequest): Promise<PersonaResponse> {
    this.calls.push(request);
    const key = `${request.persona}:${request.phase}`;
    const responder = this.byPersonaAndPhase[key] ?? this.byPersonaAndPhase[request.persona] ?? this.fallback;
    const value = responder(request);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { text, provider: 'fake', model: 'fake-model' };
  }
}

export function fakeProviderPool(scripts: Partial<Record<string, ScriptedResponder>> = {}): (persona: PersonaCodename) => ModelProvider {
  const provider = new ScriptedModelProvider(scripts);
  return () => provider;
}

/** A provider that always throws — for exercising the "failed lane" path. */
export const throwingProvider: ModelProvider = {
  async generate(): Promise<PersonaResponse> {
    throw new Error('simulated provider failure');
  },
};

export function minimalPersonaConfig(overrides: Partial<PersonaConfig> & { codename: string }): PersonaConfig {
  return {
    name: overrides.codename,
    role: 'runtime_hunter',
    temperament: { calm: 'low' },
    allowed_outcomes: { submit_finding: 'send to sparring' },
    hard_rules: ['never_directly_mutate_github_state'],
    persona_anchor: 'test anchor',
    authority_boundary: {
      can_mutate_github: false,
      can_submit_pr_review_state: false,
      can_resolve_review_threads: false,
      can_call_arbitrary_tools: false,
      can_execute_repository_code: false,
      can_override_orchestrator: false,
    },
    ...overrides,
  };
}

export const TEST_PERSONAS = new Map(
  (['leo', 'raph', 'donnie', 'mikey', 'splinter', 'april', 'casey', 'shredder'] as const).map((codename) => [
    codename,
    minimalPersonaConfig({ codename, name: codename }),
  ]),
);

export interface FakeGitHubState {
  headSha: string;
  reviews: { body: string; event: GitHubReviewOutcome; commit_id?: string }[];
}

/** A minimal fake satisfying PublicationGitHubClient — enough to test SHA staleness and idempotent posting without a network call. */
export class FakeGitHubClient implements PublicationGitHubClient {
  constructor(public readonly state: FakeGitHubState) {}

  async getPullRequest(): Promise<{ head: { sha: string } }> {
    return { head: { sha: this.state.headSha } };
  }

  async createReview(
    _installationId: number,
    _repo: RepoRef,
    _pullNumber: number,
    review: { body: string; event: GitHubReviewOutcome; commit_id?: string },
  ): Promise<{ id: number }> {
    this.state.reviews.push(review);
    return { id: this.state.reviews.length };
  }
}

export function noopResponder(): ScriptedResponder {
  return () => ({});
}

export function phaseKey(persona: PersonaCodename, phase: Phase): string {
  return `${persona}:${phase}`;
}
