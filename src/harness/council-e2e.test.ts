import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultCouncilScript } from './fixtures.js';
import { pullRequestEvent, startHarness, type Harness } from './harness.js';

/**
 * Proves the real production wiring for HALF_SHELL_REVIEW_ENGINE=council
 * (Issue #14 / #15): the same webhook entrypoint, signature verification,
 * and delivery handling as v1, but routed to the council orchestration
 * engine (src/orchestration/) end to end through to a real GitHub
 * publication call. Engine-internal behavior (supersession, staleness,
 * Sparring, corroboration, ...) is covered exhaustively in
 * src/orchestration/engine.test.ts — this file only proves the webhook
 * boundary actually reaches that engine instead of v1.
 */
describe('end to end — council engine', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it('reviews an opened pull request from webhook through the council engine to a published comment', async () => {
    harness = await startHarness({ reviewEngine: 'council', script: defaultCouncilScript() });

    const status = await harness.deliver('pull_request', pullRequestEvent('opened'));
    expect(status).toBe(202);

    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the council review to be posted');

    const review = harness.github.reviews[0]!;
    expect(review.event).toBe('COMMENT');
    expect(review.body).toContain('Half-Shell Council Review');

    // The real council phases ran — not a stand-in.
    const phases = new Set(harness.inference.requests.map((request) => request.phase));
    expect(phases.has('council_case_file')).toBe(true);
    expect(phases.has('council_independent_review')).toBe(true);
    expect(phases.has('council_leo_review')).toBe(true);
  });

  it('does not auto-trigger a new council review on synchronize alone', async () => {
    harness = await startHarness({ reviewEngine: 'council', script: defaultCouncilScript() });
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the first council review');

    const status = await harness.deliver('pull_request', pullRequestEvent('synchronize'));
    expect(status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.github.reviews).toHaveLength(1);
  });

  it('does not double-publish a duplicate webhook delivery', async () => {
    harness = await startHarness({ reviewEngine: 'council', script: defaultCouncilScript() });

    const raw = JSON.stringify(pullRequestEvent('opened'));
    const signature = `sha256=${createHmac('sha256', 'harness-secret').update(raw).digest('hex')}`;
    const send = () =>
      fetch(harness!.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'council-dup-1',
          'x-hub-signature-256': signature,
        },
        body: raw,
      });

    expect((await send()).status).toBe(202);
    await harness.waitFor(() => harness!.github.reviews.length > 0, 'the first delivery to publish');
    expect((await send()).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(harness.github.reviews).toHaveLength(1);
  });
});
