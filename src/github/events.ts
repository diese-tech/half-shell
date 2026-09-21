import type { JobKind, ReviewDepth, ReviewJob } from '../types.js';

export interface WebhookDelivery {
  event: string;
  deliveryId: string;
  payload: Record<string, any>;
}

/**
 * The public command surface is intentionally small (docs/architecture/
 * review-policy.md section 1, decisions D001/D005/D006/D008): bare
 * `@half-shell` reviews or re-reviews the current PR state, and
 * `@half-shell explain` reads back the latest review without starting a
 * new one. `review`, `deep review`, `verify`, `reconsider`, and `cancel`
 * are no longer distinct public commands — verification/reconsideration
 * remain internal operations the orchestrator selects itself (see the
 * implicit-reply handling below), and any of those old words typed after
 * the mention just falls through to a plain review rather than doing
 * nothing, since a mention with trailing text is still a mention.
 */
const MENTION = /@half-shell\b(?:\s+(\S+))?/i;

export interface ParsedCommand {
  kind: JobKind;
  depth: ReviewDepth;
}

export function parseCommand(body: string | undefined | null): ParsedCommand | undefined {
  if (!body) return undefined;
  const match = MENTION.exec(body);
  if (!match) return undefined;
  const keyword = (match[1] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (keyword === 'explain') return { kind: 'explain', depth: 'standard' };
  return { kind: 'review', depth: 'standard' };
}

/**
 * Maps a webhook delivery to at most one job. Anything Half-Shell has no
 * business acting on — its own comments, drafts, closed PRs — maps to nothing.
 */
export function toReviewJob(
  delivery: WebhookDelivery,
  appLogin: string,
): ReviewJob | undefined {
  const { event, payload } = delivery;
  const installationId = Number(payload['installation']?.id);
  if (!Number.isInteger(installationId)) return undefined;

  const sender = String(payload['sender']?.login ?? '');
  if (sender === appLogin) return undefined;

  const repository = payload['repository'];
  if (!repository?.owner?.login || !repository?.name) return undefined;
  const repo = { owner: String(repository.owner.login), repo: String(repository.name) };
  const base = { repo, installationId, deliveryId: delivery.deliveryId };

  if (event === 'pull_request') {
    // Automatic review triggers (review-policy.md section 1, D009/D010):
    // a newly opened non-draft PR, or a draft moving to ready for review.
    // A later `synchronize` (pushed commits) does not auto-trigger a new
    // full review — the PR just becomes potentially stale until someone
    // (or something) says `@half-shell` again.
    const action = String(payload['action'] ?? '');
    const pr = payload['pull_request'];
    if (!pr) return undefined;
    const eligible = action === 'ready_for_review' || (action === 'opened' && !pr.draft);
    if (!eligible) return undefined;
    return { ...base, kind: 'review', depth: 'standard', pullNumber: Number(pr.number) };
  }

  if (event === 'issue_comment') {
    if (String(payload['action'] ?? '') !== 'created') return undefined;
    const issue = payload['issue'];
    if (!issue?.pull_request) return undefined;
    const command = parseCommand(payload['comment']?.body);
    if (!command) return undefined;
    return {
      ...base,
      kind: command.kind,
      depth: command.depth,
      pullNumber: Number(issue.number),
      thread: {
        commentId: Number(payload['comment'].id),
        body: String(payload['comment'].body ?? ''),
        author: sender,
      },
    };
  }

  if (event === 'pull_request_review_comment') {
    if (String(payload['action'] ?? '') !== 'created') return undefined;
    const comment = payload['comment'];
    const pr = payload['pull_request'];
    if (!comment || !pr) return undefined;
    const command = parseCommand(comment.body);
    // A reply inside a Half-Shell thread is treated as new evidence even
    // without an explicit command; unrelated threads need one.
    const isReply = Boolean(comment.in_reply_to_id);
    if (!command && !isReply) return undefined;
    // A reply is about that specific finding — targeted verification/
    // reconsideration (review-policy.md D007), not a fresh full review —
    // regardless of what word, if any, follows the mention. `explain`
    // stays read-only even inside a thread (D008).
    const kind: JobKind = command?.kind === 'explain' ? 'explain' : isReply ? 'verify' : 'review';
    return {
      ...base,
      kind,
      depth: 'standard',
      pullNumber: Number(pr.number),
      thread: {
        commentId: Number(comment.id),
        inReplyToId: comment.in_reply_to_id ? Number(comment.in_reply_to_id) : undefined,
        body: String(comment.body ?? ''),
        author: sender,
        path: comment.path ? String(comment.path) : undefined,
        line: comment.line ? Number(comment.line) : undefined,
        // Whether this thread is one of ours is decided against stored state,
        // which this layer cannot see.
        implicit: !command,
      },
    };
  }

  return undefined;
}
