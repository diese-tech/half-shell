#!/usr/bin/env node
import { loadConfig } from './config.js';
import { GitHubClient } from './github/client.js';
import { buildChangeContext } from './github/context.js';
import { buildDiffIndex } from './github/diff.js';
import { renderReview } from './github/publish.js';
import { log } from './logger.js';
import { runReview } from './pipeline/review.js';
import { ProviderRouter } from './providers/router.js';

/**
 * Run the pipeline against a real pull request without a webhook. Prints the
 * verdict and the review Half-Shell would post; never writes to GitHub.
 *
 *   half-shell --repo owner/name --pr 42 [--deep] [--json]
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const target = args['repo'];
  const pullNumber = Number(args['pr']);
  const installationId = Number(args['installation'] ?? process.env['GITHUB_INSTALLATION_ID']);

  if (!target || !target.includes('/') || !Number.isInteger(pullNumber)) {
    process.stderr.write(
      'usage: half-shell --repo <owner/name> --pr <number> [--installation <id>] [--deep] [--json]\n',
    );
    return 2;
  }

  const config = loadConfig();
  if (!config.github) {
    process.stderr.write('GitHub App credentials are not configured (see .env.example)\n');
    return 2;
  }
  if (!Number.isInteger(installationId)) {
    process.stderr.write('pass --installation <id> or set GITHUB_INSTALLATION_ID\n');
    return 2;
  }

  const [owner, name] = target.split('/');
  const repo = { owner: owner as string, repo: name as string };
  const client = new GitHubClient(config.github);
  const router = ProviderRouter.fromConfig(config.providers, {
    allowPaid: config.allowPaidInference,
  });
  if (router.isEmpty) {
    process.stderr.write('no usable inference providers are configured\n');
    return 2;
  }

  const context = await buildChangeContext(
    client,
    installationId,
    repo,
    pullNumber,
    config.review,
  );
  const { run, rationale } = await runReview(router, context, {
    depth: args['deep'] === 'true' ? 'deep' : 'standard',
    maxPatchChars: config.review.maxPatchChars,
    maxPromptChars: config.review.maxPromptChars,
  });

  if (args['json'] === 'true') {
    process.stdout.write(`${JSON.stringify(run.verdict, null, 2)}\n`);
    return run.verdict.complete ? 0 : 1;
  }

  const diffs = buildDiffIndex(context.files);
  const { body, comments } = renderReview(context, run.verdict, diffs, rationale);
  process.stdout.write(`${body}\n\n`);
  for (const comment of comments) {
    process.stdout.write(`--- ${comment.path}:${comment.line}\n${comment.body}\n\n`);
  }
  return run.verdict.complete ? 0 : 1;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log.error('cli failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
