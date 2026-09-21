import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Structural proof of the authority boundary (review-policy.md, D-index and
 * "Authority" section; config/council/orchestration.yaml's `authority`
 * block), not just prompt language a model could ignore: no Council persona
 * phase — including Leo's — ever receives or references a GitHub mutation
 * client. Only src/orchestration/phases/publication.ts, owned entirely by
 * the orchestrator, is allowed to reference one. Every phase's own
 * ModelProvider interface (src/orchestration/provider.ts) only ever returns
 * text, so this is also enforced by the type system — this test protects
 * against a future edit quietly widening a phase's dependencies.
 */
const PERSONA_PHASE_FILES = [
  'src/orchestration/phases/caseFile.ts',
  'src/orchestration/phases/independentReview.ts',
  'src/orchestration/phases/mentorship.ts',
  'src/orchestration/phases/sparring.ts',
  'src/orchestration/phases/leoReview.ts',
  'src/orchestration/synthesis.ts',
];

const GITHUB_MUTATION_MARKERS = ['GitHubClient', 'PublicationGitHubClient', 'createReview', 'getPullRequest'];

describe('council authority boundary — structural', () => {
  it.each(PERSONA_PHASE_FILES)('%s never references a GitHub mutation client', async (path) => {
    const source = await readFile(path, 'utf8');
    for (const marker of GITHUB_MUTATION_MARKERS) {
      expect(source).not.toContain(marker);
    }
  });

  it('only PUBLICATION, owned by the orchestrator, calls the GitHub mutation client', async () => {
    const source = await readFile('src/orchestration/phases/publication.ts', 'utf8');
    expect(source).toContain('createReview');
    expect(source).toContain('PublicationGitHubClient');
  });

  it('the engine hands the GitHub client only to publish(), never to a persona phase call', async () => {
    const source = await readFile('src/orchestration/engine.ts', 'utf8');
    const publishCall = /publish\([^)]*deps\.githubClient[^)]*\)/;
    expect(publishCall.test(source)).toBe(true);

    const phaseCalls = ['runCaseFile(', 'runIndependentReview(', 'runMentorship(', 'spar(', 'runLeoReview('];
    for (const call of phaseCalls) {
      const start = source.indexOf(call);
      expect(start).toBeGreaterThan(-1);
      const argsEnd = source.indexOf(');', start);
      const args = source.slice(start, argsEnd);
      expect(args).not.toContain('githubClient');
    }
  });
});
