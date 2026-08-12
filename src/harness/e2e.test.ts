import { afterEach, describe, expect, it } from 'vitest';

import { defaultScript, SAMPLE_PULL_REQUEST } from './fixtures.js';
import {
  issueCommentEvent,
  pullRequestEvent,
  reviewCommentEvent,
  startHarness,
  type Harness,
} from './harness.js';

/**
 * These run the real service over HTTP. Only GitHub and the model are stubs —
 * signature verification, App JWT signing, installation tokens, the council
 * pipeline, publication and persistence are all production code.
 */
describe('end to end', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it('reviews an opened pull request from webhook to published comment', async () => {
    harness = await startHarness();

    const status = await harness.deliver('pull_request', pullRequestEvent('opened'));
    expect(status).toBe(202);

    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    const review = harness.github.reviews[0]!;
    expect(review.event).toBe('COMMENT');
    expect(review.commit_id).toBe(SAMPLE_PULL_REQUEST.headSha);
    expect(review.body).toContain('Half-Shell — The Verdict');
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: 'src/import.ts', side: 'RIGHT' });
    expect(review.comments[0]?.body).toContain('still calls load()');

    // Every phase actually ran against the provider.
    const phases = new Set(harness.inference.requests.map((request) => request.phase));
    expect([...phases].sort()).toEqual(['brief', 'lane', 'shredder', 'sparring', 'verdict']);

    // Six investigators ran independently in Phase 2.
    const lanes = harness.inference.requests.filter((request) => request.phase === 'lane');
    expect(new Set(lanes.map((lane) => lane.persona)).size).toBe(6);
  });

  it('rejects a delivery whose signature does not verify', async () => {
    harness = await startHarness();

    const response = await fetch(harness.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'forged',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      body: JSON.stringify(pullRequestEvent('opened')),
    });

    expect(response.status).toBe(401);
    expect(harness.github.reviews).toHaveLength(0);
  });

  it('never sends investigator names into deliberation prompts', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    const deliberation = harness.inference.requests.filter(
      (request) => request.phase === 'sparring' || request.phase === 'verdict',
    );
    expect(deliberation.length).toBeGreaterThan(0);
    for (const request of deliberation) {
      for (const name of ['Raphael', 'Donatello', 'Michelangelo', 'Splinter', 'Casey Jones']) {
        expect(request.user).not.toContain(name);
      }
    }
  });

  it('answers a reply in its own thread and records the resolution', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    const thread = harness.github.inlineComments[0]!;
    await harness.deliver(
      'pull_request_review_comment',
      reviewCommentEvent('Pushed a fix that threads tenantId through.', thread.id, {
        path: 'src/import.ts',
        line: 13,
      }),
    );

    await harness.waitFor(() => harness!.github.replies.length > 0, 'the follow-up reply');
    expect(harness.github.replies[0]?.commentId).toBe(thread.id);
    expect(harness.github.replies[0]?.body).toContain('Resolved');
  });

  it('ignores a reply in a thread that is not its own', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    const before = harness.inference.requests.length;
    await harness.deliver(
      'pull_request_review_comment',
      reviewCommentEvent('Unrelated naming discussion.', 4242, { path: 'src/import.ts' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.github.replies).toHaveLength(0);
    // No inference was spent on someone else's conversation.
    expect(harness.inference.requests.length).toBe(before);
  });

  it('stays silent on a second review that finds nothing new', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the first review');

    await harness.deliver('pull_request', pullRequestEvent('synchronize'));
    await harness.waitFor(
      () => harness!.inference.requests.some((request, index) => request.phase === 'verdict' && index > 5),
      'the second review to finish',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(harness.github.reviews).toHaveLength(1);
  });

  it('re-anchors a surviving finding after a force-push moves it', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the first review');

    const thread = harness.github.inlineComments[0]!;
    expect(thread.line).toBe(12);

    // The same defect, now further down the file after a rebase.
    harness.github.setPullRequest({
      ...SAMPLE_PULL_REQUEST,
      headSha: 'aaaa111bbbb22',
      files: [
        SAMPLE_PULL_REQUEST.files[0]!,
        {
          ...SAMPLE_PULL_REQUEST.files[1]!,
          patch: [
            '@@ -40,7 +40,7 @@ export async function importRecords(ids: string[]) {',
            '   const results = [];',
            '   for (const id of ids) {',
            '-    results.push(load(id));',
            '+    results.push(load(id));',
            '   }',
            '   return results;',
            ' }',
          ].join('\n'),
        },
      ],
    });

    await harness.deliver('pull_request', pullRequestEvent('synchronize'));
    await harness.waitFor(() => harness!.github.replies.length > 0, 'the re-anchor reply');

    expect(harness.github.replies[0]?.commentId).toBe(thread.id);
    expect(harness.github.replies[0]?.body).toContain('Still applies');
    expect(harness.github.replies[0]?.body).toContain('src/import.ts:42');
    // Re-anchoring is not a second review.
    expect(harness.github.reviews).toHaveLength(1);
  });

  it('reports the run record on @half-shell explain', async () => {
    harness = await startHarness();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    await harness.deliver('issue_comment', issueCommentEvent('@half-shell explain'));
    await harness.waitFor(() => harness!.github.issueComments.length > 0, 'the explain comment');

    expect(harness.github.issueComments[0]).toContain('Review completed: yes');
  });

  it('publishes nothing and says so when the verdict phase is unusable', async () => {
    harness = await startHarness({
      script: { ...defaultScript(), verdict: 'the model is having a moment' },
    });

    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted');

    const review = harness.github.reviews[0]!;
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('Review did not complete');
  });

  it('recovers from a transient GitHub failure', async () => {
    harness = await startHarness();
    // The files endpoint 500s twice before succeeding.
    harness.github.failures.set('GET /repos/diese-tech/half-shell/pulls/42/files', {
      status: 500,
      times: 2,
    });

    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the review to be posted', 20_000);

    const fileRequests = harness.github.requests.filter((request) =>
      request.path.endsWith('/files'),
    );
    expect(fileRequests.length).toBeGreaterThanOrEqual(3);
    expect(harness.github.reviews[0]?.comments).toHaveLength(1);
  }, 30_000);

  it('gives up on a GitHub failure that is not retryable', async () => {
    harness = await startHarness();
    harness.github.failures.set('GET /repos/diese-tech/half-shell/pulls/42', {
      status: 404,
      times: 99,
    });

    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(harness.github.reviews).toHaveLength(0);
    // One attempt, not four: a 404 is not worth retrying.
    expect(harness.github.requests.filter((r) => /\/pulls\/42$/.test(r.path))).toHaveLength(1);
  });

  it('does not review a draft pull request', async () => {
    harness = await startHarness({
      pullRequest: { ...SAMPLE_PULL_REQUEST, draft: true },
    });

    await harness.deliver('pull_request', pullRequestEvent('synchronize', { ...SAMPLE_PULL_REQUEST, draft: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(harness.github.reviews).toHaveLength(0);
    expect(harness.inference.requests).toHaveLength(0);
  });
});
