import type { JobKind, ReviewDepth, ReviewJob } from '../types.js';

export interface WebhookDelivery {
  event: string;
  deliveryId: string;
  payload: Record<string, any>;
}

const COMMAND = /@half-shell\s+(deep\s+review|review|verify|reconsider|explain)\b/i;

export interface ParsedCommand {
  kind: JobKind;
  depth: ReviewDepth;
}

export function parseCommand(body: string | undefined | null): ParsedCommand | undefined {
  if (!body) return undefined;
  const match = COMMAND.exec(body);
  if (!match) return undefined;
  const raw = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
  switch (raw) {
    case 'deep review':
      return { kind: 'review', depth: 'deep' };
    case 'review':
      return { kind: 'review', depth: 'standard' };
    case 'verify':
      return { kind: 'verify', depth: 'standard' };
    case 'reconsider':
      return { kind: 'reconsider', depth: 'standard' };
    case 'explain':
      return { kind: 'explain', depth: 'standard' };
    default:
      return undefined;
  }
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
    const action = String(payload['action'] ?? '');
    const pr = payload['pull_request'];
    if (!pr) return undefined;
    if (pr.draft && action !== 'ready_for_review') return undefined;
    if (!['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(action)) {
      return undefined;
    }
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
    return {
      ...base,
      kind: command?.kind ?? 'verify',
      depth: command?.depth ?? 'standard',
      pullNumber: Number(pr.number),
      thread: {
        commentId: Number(comment.id),
        inReplyToId: comment.in_reply_to_id ? Number(comment.in_reply_to_id) : undefined,
        body: String(comment.body ?? ''),
        author: sender,
        path: comment.path ? String(comment.path) : undefined,
        line: comment.line ? Number(comment.line) : undefined,
      },
    };
  }

  return undefined;
}
