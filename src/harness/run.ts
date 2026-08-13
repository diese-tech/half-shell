#!/usr/bin/env node
import type { Config } from '../config.js';
import { defaultScript, SAMPLE_PULL_REQUEST } from './fixtures.js';
import { HARNESS_REPO, pullRequestEvent, startHarness } from './harness.js';

/**
 * Runs one full review against the stub servers and prints what Half-Shell
 * would have posted. No credentials, no network, no GitHub App required:
 *
 *   npm run harness
 *
 * Use it to see the shape of a review, or to sanity-check the pipeline after
 * a change without waiting on a real provider.
 *
 * Set HALF_SHELL_HARNESS_OLLAMA_MODEL to swap the stub inference server for a
 * real local Ollama model — GitHub stays stubbed, so this still needs no
 * credentials. Ollama's own server must already be running and have that
 * model pulled:
 *
 *   HALF_SHELL_HARNESS_OLLAMA_MODEL=qwen2.5:7b npm run harness
 *
 * A real model is far slower than the stub, so both the per-call timeout and
 * the wait for the review to finish are widened when this is set.
 */
async function main(): Promise<number> {
  const ollamaModel = process.env['HALF_SHELL_HARNESS_OLLAMA_MODEL'];
  const configure = ollamaModel
    ? (config: Config): void => {
        config.providers = [
          {
            id: 'ollama',
            tier: 'local',
            baseUrl: process.env['HALF_SHELL_HARNESS_OLLAMA_URL'] ?? 'http://127.0.0.1:11434/v1',
            model: ollamaModel,
            timeoutMs: 10 * 60_000,
          },
        ];
      }
    : undefined;

  const harness = await startHarness({ script: defaultScript(), configure });
  try {
    process.stdout.write(`stub GitHub:    ${harness.github.url}\n`);
    process.stdout.write(
      ollamaModel
        ? `inference:      ollama · ${ollamaModel}\n`
        : `stub inference: ${harness.inference.url}\n`,
    );
    process.stdout.write(`webhook:        ${harness.webhookUrl}\n\n`);

    const started = Date.now();
    await harness.deliver('pull_request', pullRequestEvent('opened'));
    await harness.waitFor(
      () => harness.github.reviews.length > 0,
      'the review to be posted',
      ollamaModel ? 30 * 60_000 : undefined,
    );

    const review = harness.github.reviews[0];
    if (!review) return 1;

    process.stdout.write(`--- review body ------------------------------------\n`);
    process.stdout.write(`${review.body}\n\n`);
    for (const comment of review.comments) {
      process.stdout.write(`--- ${comment.path}:${comment.line ?? '(file)'} ---\n`);
      process.stdout.write(`${comment.body}\n\n`);
    }

    if (ollamaModel) {
      // The stub inference server is never hit on this path, so its request
      // log stays empty — the persisted run is the only real source of truth.
      const run = await harness.app.lastRun(HARNESS_REPO, SAMPLE_PULL_REQUEST.number);
      const telemetry = run?.telemetry;
      process.stdout.write(
        telemetry
          ? `completed in ${Date.now() - started}ms · provider calls: ${telemetry.providerCalls}` +
              `${telemetry.providerFailures > 0 ? ` (${telemetry.providerFailures} failed)` : ''}` +
              ` · tokens: ${telemetry.promptTokens} in / ${telemetry.completionTokens} out\n`
          : `completed in ${Date.now() - started}ms · no telemetry recorded for this run\n`,
      );
    } else {
      const phases = harness.inference.requests.reduce<Record<string, number>>((counts, request) => {
        counts[request.phase] = (counts[request.phase] ?? 0) + 1;
        return counts;
      }, {});
      process.stdout.write(
        `completed in ${Date.now() - started}ms · provider calls: ${JSON.stringify(phases)}\n`,
      );
    }
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
