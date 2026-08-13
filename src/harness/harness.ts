import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HalfShellApp } from '../app.js';
import type { Config } from '../config.js';
import { createWebhookServer } from '../server.js';
import { closeServer, startStubInference, type Script, type StubInference } from './stub-inference.js';
import { startStubGitHub, type StubGitHub, type StubPullRequest } from './stub-github.js';
import { defaultScript, SAMPLE_PULL_REQUEST } from './fixtures.js';

/**
 * Boots the real service against stub GitHub and stub inference servers.
 * Everything below the network boundary is production code: signature
 * verification, App JWT signing, installation tokens, the council pipeline,
 * publication and persistence.
 */
/** The stub GitHub repo every harness webhook payload is addressed to. */
export const HARNESS_REPO = { owner: 'diese-tech', repo: 'half-shell' };

export interface Harness {
  github: StubGitHub;
  inference: StubInference;
  app: HalfShellApp;
  webhookUrl: string;
  config: Config;
  /** Deliver a signed webhook exactly as GitHub would. */
  deliver(event: string, payload: Record<string, unknown>): Promise<number>;
  /** Resolve once `predicate` holds, or throw after `timeoutMs`. */
  waitFor(predicate: () => boolean, description: string, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  script?: Script;
  pullRequest?: StubPullRequest;
  configure?: (config: Config) => void;
}

const WEBHOOK_SECRET = 'harness-secret';

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const inference = await startStubInference(options.script ?? defaultScript());
  const github = await startStubGitHub(options.pullRequest ?? SAMPLE_PULL_REQUEST);
  const dataDir = await mkdtemp(join(tmpdir(), 'half-shell-harness-'));

  // A real key pair, so the App JWT is genuinely signed and verified as RS256.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const config: Config = {
    port: 0,
    github: {
      appId: '424242',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      webhookSecret: WEBHOOK_SECRET,
      appLogin: 'half-shell[bot]',
      apiBaseUrl: github.url,
    },
    providers: [
      { id: 'stub', tier: 'local', baseUrl: inference.url, model: 'stub-model', timeoutMs: 30_000 },
    ],
    providerProblems: [],
    allowPaidInference: false,
    review: {
      maxFiles: 40,
      maxPatchChars: 12_000,
      maxPromptChars: 120_000,
      maxRelatedFiles: 5,
      maxRelatedChars: 6_000,
      maxRelatedLookups: 30,
      searchCallers: true,
      dryRun: false,
      dataDir,
      store: 'file',
      databasePath: join(dataDir, 'half-shell.db'),
      excludePatterns: [/(^|\/)package-lock\.json$/],
    },
  };
  options.configure?.(config);

  const app = new HalfShellApp(config);
  const server: Server = createWebhookServer(app, config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;

  return {
    github,
    inference,
    app,
    webhookUrl,
    config,
    async deliver(event, payload) {
      const raw = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')}`;
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': `harness-${Date.now()}`,
          'x-hub-signature-256': signature,
        },
        body: raw,
      });
      return response.status;
    },
    async waitFor(predicate, description, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${description}`);
    },
    async stop() {
      await closeServer(server);
      // Let in-flight jobs finish writing before the data directory goes away.
      await app.idle();
      await github.close();
      await inference.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Webhook payload for a pull request event, matching GitHub's shape. */
export function pullRequestEvent(
  action: string,
  pr: StubPullRequest = SAMPLE_PULL_REQUEST,
  sender = 'dev',
): Record<string, unknown> {
  return {
    action,
    installation: { id: 987 },
    sender: { login: sender },
    repository: { name: 'half-shell', owner: { login: 'diese-tech' } },
    pull_request: { number: pr.number, draft: pr.draft ?? false },
  };
}

export function reviewCommentEvent(
  body: string,
  inReplyToId: number | undefined,
  options: { path?: string; line?: number; sender?: string; commentId?: number } = {},
): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 987 },
    sender: { login: options.sender ?? 'coding-agent' },
    repository: { name: 'half-shell', owner: { login: 'diese-tech' } },
    pull_request: { number: SAMPLE_PULL_REQUEST.number },
    comment: {
      id: options.commentId ?? 7777,
      in_reply_to_id: inReplyToId,
      body,
      path: options.path,
      line: options.line,
    },
  };
}

export function issueCommentEvent(body: string, sender = 'dev'): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 987 },
    sender: { login: sender },
    repository: { name: 'half-shell', owner: { login: 'diese-tech' } },
    issue: { number: SAMPLE_PULL_REQUEST.number, pull_request: {} },
    comment: { id: 8888, body },
  };
}
