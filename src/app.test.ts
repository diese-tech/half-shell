import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HalfShellApp } from './app.js';
import type { Config } from './config.js';
import type { GitHubClient, PullRequestPayload, ReviewComment } from './github/client.js';
import { toReviewJob } from './github/events.js';
import { ProviderRouter } from './providers/router.js';
import type { CompletionRequest, CompletionResult, Provider } from './providers/types.js';
import { FileStore } from './store/store.js';
import type { ChangedFile } from './types.js';

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' export function load(id: string) {',
  '-  return query(id);',
  '+  return query(id, tenantId);',
  '+  // TODO: propagate tenantId from callers',
  ' }',
].join('\n');

const FINDING = {
  severity: 'high',
  confidence: 0.9,
  category: 'contract',
  file: 'src/loader.ts',
  line: 2,
  claim: 'Callers still invoke load() without a tenant id.',
  evidence: 'query() now takes tenantId but the call site does not receive it.',
  failure_mode: 'load() throws because tenantId is undefined.',
  suggested_fix: 'Thread tenantId through load().',
};

/** Answers each phase from a script keyed on the appended phase instruction. */
function scriptedProvider(findings: unknown[] = [FINDING]): Provider {
  return {
    id: 'scripted',
    tier: 'local',
    model: 'scripted',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const instruction = request.system.split('</your_role>').at(-1) ?? '';
      const reply = (text: string) => ({ text, provider: 'scripted', model: 'scripted' });

      if (instruction.includes('Phase 1')) {
        return reply(
          JSON.stringify({
            claimed_change: 'tenant scoping',
            actual_change: 'loader requires tenantId',
            constraints: [],
            prior_behavior: 'no tenant scoping',
            uncertainty: [],
          }),
        );
      }
      if (instruction.includes('Phase 2')) {
        const isRaphael = request.system.startsWith('You are Raphael');
        return reply(JSON.stringify({ findings: isRaphael ? findings : [] }));
      }
      if (instruction.includes('Phase 6')) {
        return reply(
          JSON.stringify({
            decisions: findings.map((_, index) => ({
              finding_id: `HS-${String(index + 1).padStart(3, '0')}`,
              decision: 'PUBLISH',
              reasoning: 'the stale call site is in this diff',
            })),
            unresolved_uncertainty: [],
          }),
        );
      }
      return reply('{"critiques": []}');
    },
  };
}

/** Adds scripted follow-up answers on top of the review script. */
function verifyingProvider(): Provider {
  const base = scriptedProvider();
  return {
    id: 'scripted',
    tier: 'local',
    model: 'scripted',
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const instruction = request.system.split('</your_role>').at(-1) ?? '';
      const reply = (text: string) => ({ text, provider: 'scripted', model: 'scripted' });

      if (instruction.includes('Follow-up adjudication')) {
        return reply(
          JSON.stringify({
            status: 'RESOLVED',
            reasoning: 'the call site now passes tenantId',
            evidence: 'src/loader.ts line 2',
          }),
        );
      }
      if (instruction.includes('Follow-up')) {
        return reply('{"assessment": "fixed", "still_reachable": false}');
      }
      return base.complete(request);
    },
  };
}

interface PostedReview {
  body: string;
  comments?: ReviewComment[];
}

class FakeGitHub {
  readonly reviews: PostedReview[] = [];
  readonly comments: string[] = [];
  files: ChangedFile[] = [
    { path: 'src/loader.ts', status: 'modified', additions: 2, deletions: 1, truncated: false, patch: PATCH },
  ];

  async getPullRequest(): Promise<PullRequestPayload> {
    return {
      number: 12,
      title: 'Require a tenant id when loading records',
      body: 'Adds tenant scoping.',
      draft: false,
      user: { login: 'dev' },
      head: { sha: 'def5678000', ref: 'feature' },
      base: { sha: 'abc1234000', ref: 'main' },
    };
  }

  async listFiles(): Promise<ChangedFile[]> {
    return this.files;
  }

  async getFileContent(): Promise<string | undefined> {
    return undefined;
  }

  async getIssue(): Promise<undefined> {
    return undefined;
  }

  async createReview(
    _installation: number,
    _repo: unknown,
    _number: number,
    review: PostedReview,
  ): Promise<{ id: number }> {
    this.reviews.push(review);
    for (const comment of review.comments ?? []) {
      this.inlineComments.push({
        id: 1000 + this.inlineComments.length,
        path: comment.path,
        line: comment.line ?? null,
        body: comment.body,
      });
    }
    return { id: this.reviews.length };
  }

  readonly inlineComments: { id: number; path: string; line: number | null; body: string }[] = [];

  async listReviewComments(): Promise<typeof this.inlineComments> {
    return this.inlineComments;
  }

  readonly replies: { commentId: number; body: string }[] = [];

  async createIssueComment(
    _installation: number,
    _repo: unknown,
    _number: number,
    body: string,
  ): Promise<{ id: number }> {
    this.comments.push(body);
    return { id: this.comments.length };
  }

  async replyToReviewComment(
    _installation: number,
    _repo: unknown,
    _number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    this.replies.push({ commentId, body });
    return { id: 2000 + this.replies.length };
  }
}

const REPO = { owner: { login: 'diese-tech' }, name: 'half-shell' };

function openedPullRequest() {
  return toReviewJob(
    {
      event: 'pull_request',
      deliveryId: 'delivery-1',
      payload: {
        action: 'opened',
        installation: { id: 7 },
        sender: { login: 'dev' },
        repository: REPO,
        pull_request: { number: 12, draft: false },
      },
    },
    'half-shell[bot]',
  )!;
}

describe('HalfShellApp', () => {
  let dataDir: string;
  let config: Config;
  let github: FakeGitHub;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'half-shell-test-'));
    github = new FakeGitHub();
    config = {
      port: 0,
      github: {
        appId: '1',
        privateKey: 'key',
        webhookSecret: 'secret',
        appLogin: 'half-shell[bot]',
        apiBaseUrl: 'https://api.github.com',
      },
      providers: [],
      allowPaidInference: false,
      review: {
        maxFiles: 40,
        maxPatchChars: 5000,
        maxPromptChars: 120_000,
        dryRun: false,
        dataDir,
        excludePatterns: [/(^|\/)package-lock\.json$/],
      },
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function app(provider: Provider = scriptedProvider()): HalfShellApp {
    return new HalfShellApp(config, {
      client: github as unknown as GitHubClient,
      store: new FileStore(dataDir),
      createRouter: () => new ProviderRouter([provider], { allowPaid: false }),
    });
  }

  it('reviews an opened pull request and posts inline findings', async () => {
    await app().enqueue(openedPullRequest());

    expect(github.reviews).toHaveLength(1);
    const review = github.reviews[0] as PostedReview;
    expect(review.body).toContain('Half-Shell — The Verdict');
    expect(review.comments).toHaveLength(1);
    expect(review.comments?.[0]).toMatchObject({ path: 'src/loader.ts', line: 2, side: 'RIGHT' });
    expect(review.comments?.[0]?.body).toContain('Callers still invoke load()');
  });

  it('persists the run and the published findings', async () => {
    await app().enqueue(openedPullRequest());

    const store = new FileStore(dataDir);
    const repo = { owner: 'diese-tech', repo: 'half-shell' };
    expect(await store.listRuns(repo, 12)).toHaveLength(1);
    expect(await store.listPublished(repo, 12)).toHaveLength(1);
  });

  it('does not repost a finding it already published on an earlier commit', async () => {
    const instance = app();
    await instance.enqueue(openedPullRequest());
    await instance.enqueue(openedPullRequest());

    expect(github.reviews).toHaveLength(1);
  });

  it('posts nothing when the change has no reviewable files', async () => {
    github.files = [
      { path: 'package-lock.json', status: 'modified', additions: 9, deletions: 1, truncated: false, patch: PATCH },
    ];

    await app().enqueue(openedPullRequest());

    expect(github.reviews).toHaveLength(0);
  });

  it('reports the review record on @half-shell explain', async () => {
    const instance = app();
    await instance.enqueue(openedPullRequest());

    const explain = toReviewJob(
      {
        event: 'issue_comment',
        deliveryId: 'delivery-2',
        payload: {
          action: 'created',
          installation: { id: 7 },
          sender: { login: 'dev' },
          repository: REPO,
          issue: { number: 12, pull_request: {} },
          comment: { id: 5, body: '@half-shell explain' },
        },
      },
      'half-shell[bot]',
    )!;
    await instance.enqueue(explain);

    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]).toContain('Candidate findings: 1');
  });

  it('answers a reply in the thread of the finding it belongs to', async () => {
    const instance = app(verifyingProvider());
    await instance.enqueue(openedPullRequest());

    const threadId = github.inlineComments[0]?.id as number;
    const reply = toReviewJob(
      {
        event: 'pull_request_review_comment',
        deliveryId: 'delivery-3',
        payload: {
          action: 'created',
          installation: { id: 7 },
          sender: { login: 'coding-agent' },
          repository: REPO,
          pull_request: { number: 12 },
          comment: {
            id: 5001,
            in_reply_to_id: threadId,
            body: 'Pushed a fix that threads tenantId through.',
            path: 'src/loader.ts',
            line: 2,
          },
        },
      },
      'half-shell[bot]',
    )!;
    await instance.enqueue(reply);

    expect(github.replies).toHaveLength(1);
    expect(github.replies[0]?.commentId).toBe(threadId);
    expect(github.replies[0]?.body).toContain('Resolved');

    const resolutions = await new FileStore(dataDir).listResolutions(
      { owner: 'diese-tech', repo: 'half-shell' },
      12,
    );
    expect(resolutions[0]?.status).toBe('RESOLVED');
  });

  it('records the comment id by the finding marker, not a run-local id', async () => {
    await app().enqueue(openedPullRequest());

    const [record] = await new FileStore(dataDir).listPublished(
      { owner: 'diese-tech', repo: 'half-shell' },
      12,
    );
    const comment = github.inlineComments.find((entry) => entry.id === record?.commentId);

    expect(comment).toBeDefined();
    expect(comment?.body).toContain(`half-shell-finding:${record?.key}`);
  });

  it('ignores a reply in a review thread that is not its own', async () => {
    const instance = app();
    await instance.enqueue(openedPullRequest());

    const strayReply = toReviewJob(
      {
        event: 'pull_request_review_comment',
        deliveryId: 'delivery-4',
        payload: {
          action: 'created',
          installation: { id: 7 },
          sender: { login: 'another-reviewer' },
          repository: REPO,
          pull_request: { number: 12 },
          comment: {
            id: 6001,
            // A thread started by someone else entirely.
            in_reply_to_id: 55555,
            body: 'Unrelated discussion about naming.',
            path: 'src/loader.ts',
            line: 2,
          },
        },
      },
      'half-shell[bot]',
    )!;
    await instance.enqueue(strayReply);

    expect(github.replies).toHaveLength(0);
    expect(github.comments).toHaveLength(0);
  });

  it('still answers an explicit command in someone else’s thread', async () => {
    const instance = app(verifyingProvider());
    await instance.enqueue(openedPullRequest());

    const commanded = toReviewJob(
      {
        event: 'pull_request_review_comment',
        deliveryId: 'delivery-5',
        payload: {
          action: 'created',
          installation: { id: 7 },
          sender: { login: 'dev' },
          repository: REPO,
          pull_request: { number: 12 },
          comment: {
            id: 6002,
            in_reply_to_id: 55555,
            body: '@half-shell verify',
            path: 'src/loader.ts',
            line: 2,
          },
        },
      },
      'half-shell[bot]',
    )!;
    await instance.enqueue(commanded);

    expect(github.replies).toHaveLength(1);
  });

  it('honours dry run by keeping everything local', async () => {
    config.review.dryRun = true;
    await app().enqueue(openedPullRequest());

    expect(github.reviews).toHaveLength(0);
    expect(github.comments).toHaveLength(0);
  });
});
