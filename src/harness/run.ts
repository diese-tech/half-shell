#!/usr/bin/env node
import { defaultScript } from './fixtures.js';
import { pullRequestEvent, startHarness } from './harness.js';

/**
 * Runs one full review against the stub servers and prints what Half-Shell
 * would have posted. No credentials, no network, no GitHub App required:
 *
 *   npm run harness
 *
 * Use it to see the shape of a review, or to sanity-check the pipeline after
 * a change without waiting on a real provider.
 */
async function main(): Promise<number> {
  const harness = await startHarness({ script: defaultScript() });
  try {
    process.stdout.write(`stub GitHub:    ${harness.github.url}\n`);
    process.stdout.write(`stub inference: ${harness.inference.url}\n`);
    process.stdout.write(`webhook:        ${harness.webhookUrl}\n\n`);

    const started = Date.now();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(() => harness.github.reviews.length > 0, 'the review to be posted');

    const review = harness.github.reviews[0];
    if (!review) return 1;

    process.stdout.write(`--- review body ------------------------------------\n`);
    process.stdout.write(`${review.body}\n\n`);
    for (const comment of review.comments) {
      process.stdout.write(`--- ${comment.path}:${comment.line ?? '(file)'} ---\n`);
      process.stdout.write(`${comment.body}\n\n`);
    }

    const phases = harness.inference.requests.reduce<Record<string, number>>((counts, request) => {
      counts[request.phase] = (counts[request.phase] ?? 0) + 1;
      return counts;
    }, {});
    process.stdout.write(
      `completed in ${Date.now() - started}ms · provider calls: ${JSON.stringify(phases)}\n`,
    );
    return 0;
  } finally {
    await harness.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
