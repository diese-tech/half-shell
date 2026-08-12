import type { Config } from './config.js';
import { GitHubClient } from './github/client.js';
import { buildChangeContext } from './github/context.js';
import { buildDiffIndex } from './github/diff.js';
import { findingKey, findingMarker, renderReview } from './github/publish.js';
import { log, errorFields } from './logger.js';
import { runFollowUp, renderResolution } from './pipeline/followup.js';
import { runReview } from './pipeline/review.js';
import { ProviderRouter } from './providers/router.js';
import type { Category } from './protocol/types.js';
import { FileStore, type Store } from './store/store.js';
import type { PublishedFindingRecord, ReviewJob } from './types.js';

/**
 * Runtime orchestration. This layer gathers context, drives the protocol, and
 * maps approved findings onto GitHub. It does not invent review policy.
 */
export interface AppDependencies {
  client?: GitHubClient;
  store?: Store;
  /** Overridable so tests and the CLI can supply their own inference chain. */
  createRouter?: () => ProviderRouter;
}

export class HalfShellApp {
  private readonly client: GitHubClient;
  private readonly store: Store;
  private readonly createRouter: () => ProviderRouter;
  /** One in-flight job per pull request; later deliveries queue behind it. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    dependencies: AppDependencies = {},
  ) {
    if (!config.github && !dependencies.client) {
      throw new Error('GitHub App credentials are not configured');
    }
    this.client = dependencies.client ?? new GitHubClient(config.github!);
    this.store = dependencies.store ?? new FileStore(config.review.dataDir);
    this.createRouter =
      dependencies.createRouter ??
      (() =>
        ProviderRouter.fromConfig(this.config.providers, {
          allowPaid: this.config.allowPaidInference,
        }));
  }

  /** Serialize work per pull request so pushes cannot interleave reviews. */
  enqueue(job: ReviewJob): Promise<void> {
    const key = `${job.repo.owner}/${job.repo.repo}#${job.pullNumber}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handle(job))
      .catch((error) => log.error('job failed', { key, ...errorFields(error) }));
    this.queues.set(key, next);
    return next;
  }

  async handle(job: ReviewJob): Promise<void> {
    switch (job.kind) {
      case 'review':
        await this.review(job);
        return;
      case 'verify':
      case 'reconsider':
        await this.followUp(job);
        return;
      case 'explain':
        await this.explain(job);
        return;
    }
  }

  private async review(job: ReviewJob): Promise<void> {
    const router = this.createRouter();
    if (router.isEmpty) {
      log.error('no usable inference providers; skipping review', { pr: job.pullNumber });
      return;
    }

    const context = await buildChangeContext(
      this.client,
      job.installationId,
      job.repo,
      job.pullNumber,
      this.config.review,
    );

    if (context.files.length === 0) {
      log.info('no reviewable files in change', { pr: job.pullNumber });
      return;
    }

    const { run, rationale } = await runReview(router, context, {
      depth: job.depth,
      maxPatchChars: this.config.review.maxPatchChars,
      maxPromptChars: this.config.review.maxPromptChars,
    });
    await this.store.saveRun(run);

    // Findings already published on an earlier commit stay in their threads.
    const alreadyPublished = new Set(
      (await this.store.listPublished(job.repo, job.pullNumber)).map((record) => record.key),
    );
    const fresh = run.verdict.published_findings.filter(
      (finding) => !alreadyPublished.has(findingKey(finding)),
    );
    const verdict = { ...run.verdict, published_findings: fresh };

    if (verdict.complete && fresh.length === 0 && alreadyPublished.size > 0) {
      log.info('no new findings since the last review; staying silent', { pr: job.pullNumber });
      return;
    }

    const diffs = buildDiffIndex(context.files);
    const { body, comments } = renderReview(context, verdict, diffs, rationale);

    if (this.config.review.dryRun) {
      log.info('dry run; review not posted', { pr: job.pullNumber, body, comments });
      return;
    }

    await this.client.createReview(job.installationId, job.repo, job.pullNumber, {
      body,
      event: 'COMMENT',
      commit_id: context.headSha,
      comments,
    });

    // Recover the ids GitHub assigned so later replies can be answered in the
    // right thread. The review endpoint only returns the review's own id, and
    // run-local ids like HS-001 repeat across runs, so match on the stable
    // per-finding marker embedded in the comment body.
    const posted = await this.client
      .listReviewComments(job.installationId, job.repo, job.pullNumber)
      .catch(() => []);

    const records: PublishedFindingRecord[] = fresh.map((finding) => ({
      key: findingKey(finding),
      findingId: finding.finding_id,
      repo: job.repo,
      pullNumber: job.pullNumber,
      headSha: context.headSha,
      file: finding.file,
      line: finding.line ?? null,
      claim: finding.claim,
      commentId: posted.find((comment) => comment.body.includes(findingMarker(finding)))?.id,
      status: 'published',
      publishedAt: new Date().toISOString(),
    }));
    await this.store.savePublished(records);
  }

  private async followUp(job: ReviewJob): Promise<void> {
    const router = this.createRouter();
    if (router.isEmpty || !job.thread) return;

    const published = await this.store.listPublished(job.repo, job.pullNumber);
    if (published.length === 0) {
      log.info('follow-up with no published findings to verify', { pr: job.pullNumber });
      return;
    }

    const target = selectTarget(published, job);
    if (!target) {
      log.info('reply is not in a Half-Shell thread; ignoring', {
        pr: job.pullNumber,
        comment: job.thread.commentId,
      });
      return;
    }
    const context = await buildChangeContext(
      this.client,
      job.installationId,
      job.repo,
      job.pullNumber,
      this.config.review,
    );

    // Match on the stable finding key: `finding_id` is only unique per run.
    const runs = await this.store.listRuns(job.repo, job.pullNumber);
    const original = runs
      .flatMap((run) => run.verdict.published_findings)
      .find((finding) => findingKey(finding) === target.key);

    const resolution = await runFollowUp(router, {
      record: target,
      category: (original?.category ?? 'bug') as Category,
      claim: target.claim,
      evidence: original?.evidence ?? 'original evidence unavailable',
      reply: job.thread.body,
      replyAuthor: job.thread.author,
      context,
      maxPatchChars: this.config.review.maxPatchChars,
    });
    if (!resolution) return;

    await this.store.saveResolution(job.repo, job.pullNumber, resolution);

    if (this.config.review.dryRun) {
      log.info('dry run; resolution not posted', { pr: job.pullNumber, resolution });
      return;
    }

    const body = renderResolution(resolution);
    const replyTo = job.thread.inReplyToId ?? target.commentId;
    if (replyTo) {
      await this.client
        .replyToReviewComment(job.installationId, job.repo, job.pullNumber, replyTo, body)
        .catch(async (error) => {
          log.warn('thread reply failed; falling back to a PR comment', errorFields(error));
          await this.client.createIssueComment(job.installationId, job.repo, job.pullNumber, body);
        });
    } else {
      await this.client.createIssueComment(job.installationId, job.repo, job.pullNumber, body);
    }
  }

  private async explain(job: ReviewJob): Promise<void> {
    const runs = await this.store.listRuns(job.repo, job.pullNumber);
    const latest = runs.at(-1);
    if (!latest) {
      log.info('explain requested with no recorded run', { pr: job.pullNumber });
      return;
    }
    const verdict = latest.verdict;
    const body = [
      '## Half-Shell — review record',
      '',
      `- Protocol: v${verdict.protocol_version}`,
      `- Reviewed \`${verdict.reviewed_sha.slice(0, 7)}\` against \`${(verdict.base_sha ?? '').slice(0, 7)}\``,
      `- Coverage: ${verdict.coverage}`,
      `- Candidate findings: ${verdict.candidate_count}`,
      `- Rejected during deliberation: ${verdict.rejected_count}`,
      `- Published: ${verdict.published_findings.length}`,
      `- Lanes completed: ${latest.lanes.filter((lane) => lane.ok).length}/${latest.lanes.length}`,
      `- Review completed: ${verdict.complete ? 'yes' : 'no'}`,
      ...((verdict.coverage_limitations ?? []).length > 0
        ? ['', '**Coverage limitations**', ...(verdict.coverage_limitations ?? []).map((l) => `- ${l}`)]
        : []),
    ].join('\n');

    if (this.config.review.dryRun) {
      log.info('dry run; explanation not posted', { pr: job.pullNumber, body });
      return;
    }
    await this.client.createIssueComment(job.installationId, job.repo, job.pullNumber, body);
  }
}

/**
 * Prefer the finding whose thread the reply landed in, then the same file.
 * An implicit reply — no command, just a message in some review thread — only
 * counts when its parent is a Half-Shell comment; otherwise unrelated
 * discussion would consume inference and mutate finding state.
 */
function selectTarget(
  published: PublishedFindingRecord[],
  job: ReviewJob,
): PublishedFindingRecord | undefined {
  const thread = job.thread;
  const byComment = thread?.inReplyToId
    ? published.find((record) => record.commentId === thread.inReplyToId)
    : undefined;
  if (byComment) return byComment;
  if (thread?.implicit) return undefined;

  if (thread?.path) {
    const sameFile = published.filter((record) => record.file === thread.path);
    if (sameFile.length === 1) return sameFile[0] as PublishedFindingRecord;
    if (sameFile.length > 1 && thread.line) {
      const nearest = [...sameFile].sort(
        (a, b) =>
          Math.abs((a.line ?? 0) - (thread.line as number)) -
          Math.abs((b.line ?? 0) - (thread.line as number)),
      );
      return nearest[0] as PublishedFindingRecord;
    }
  }
  return published.at(-1);
}
