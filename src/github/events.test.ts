import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseCommand, toReviewJob } from './events.js';
import { verifySignature } from './signature.js';

const sign = (secret: string, payload: string) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

const APP_LOGIN = 'half-shell[bot]';

function delivery(event: string, payload: Record<string, unknown>) {
  return { event, deliveryId: 'delivery-1', payload };
}

const REPO = { owner: { login: 'diese-tech' }, name: 'half-shell' };

describe('parseCommand', () => {
  it('treats a bare mention as a review — the sole public review/re-review invocation', () => {
    expect(parseCommand('@half-shell')).toEqual({ kind: 'review', depth: 'standard' });
    expect(parseCommand('hey @half-shell take a look')).toEqual({ kind: 'review', depth: 'standard' });
  });

  it('reads back the latest review without starting a new one', () => {
    expect(parseCommand('@half-shell explain')).toEqual({ kind: 'explain', depth: 'standard' });
  });

  it('treats retired public keywords as a plain review rather than a distinct command', () => {
    // review-policy.md removes `review`, `deep review`, `verify`, `reconsider`,
    // and `cancel` from the public surface (D001/D005/D006/D060) — there is
    // one adaptive review mode, so any of these now just falls through to it.
    expect(parseCommand('@half-shell review')).toEqual({ kind: 'review', depth: 'standard' });
    expect(parseCommand('@half-shell deep review')).toEqual({ kind: 'review', depth: 'standard' });
    expect(parseCommand('please @half-shell verify now')).toEqual({ kind: 'review', depth: 'standard' });
    expect(parseCommand('@half-shell reconsider')).toEqual({ kind: 'review', depth: 'standard' });
    expect(parseCommand('@half-shell cancel')).toEqual({ kind: 'review', depth: 'standard' });
  });

  it('ignores unrelated text', () => {
    expect(parseCommand('half-shell is neat')).toBeUndefined();
    expect(parseCommand(undefined)).toBeUndefined();
  });
});

describe('toReviewJob', () => {
  it('reviews an opened pull request', () => {
    const job = toReviewJob(
      delivery('pull_request', {
        action: 'opened',
        installation: { id: 7 },
        sender: { login: 'dev' },
        repository: REPO,
        pull_request: { number: 12, draft: false },
      }),
      APP_LOGIN,
    );

    expect(job).toMatchObject({ kind: 'review', pullNumber: 12, installationId: 7 });
  });

  it('ignores drafts until they are marked ready', () => {
    const payload = {
      action: 'opened',
      installation: { id: 7 },
      sender: { login: 'dev' },
      repository: REPO,
      pull_request: { number: 12, draft: true },
    };
    expect(toReviewJob(delivery('pull_request', payload), APP_LOGIN)).toBeUndefined();

    const ready = { ...payload, action: 'ready_for_review' };
    expect(toReviewJob(delivery('pull_request', ready), APP_LOGIN)?.kind).toBe('review');
  });

  it('does not auto-trigger a full review on synchronize — pushes only make the prior review stale', () => {
    const payload = {
      action: 'synchronize',
      installation: { id: 7 },
      sender: { login: 'dev' },
      repository: REPO,
      pull_request: { number: 12, draft: false },
    };
    expect(toReviewJob(delivery('pull_request', payload), APP_LOGIN)).toBeUndefined();
  });

  it('does not auto-trigger on reopened either — re-review stays explicit', () => {
    const payload = {
      action: 'reopened',
      installation: { id: 7 },
      sender: { login: 'dev' },
      repository: REPO,
      pull_request: { number: 12, draft: false },
    };
    expect(toReviewJob(delivery('pull_request', payload), APP_LOGIN)).toBeUndefined();
  });

  it('ignores its own comments so it cannot review itself in a loop', () => {
    const job = toReviewJob(
      delivery('issue_comment', {
        action: 'created',
        installation: { id: 7 },
        sender: { login: APP_LOGIN },
        repository: REPO,
        issue: { number: 12, pull_request: {} },
        comment: { id: 5, body: '@half-shell review' },
      }),
      APP_LOGIN,
    );
    expect(job).toBeUndefined();
  });

  it('ignores PR comments without a command', () => {
    const job = toReviewJob(
      delivery('issue_comment', {
        action: 'created',
        installation: { id: 7 },
        sender: { login: 'dev' },
        repository: REPO,
        issue: { number: 12, pull_request: {} },
        comment: { id: 5, body: 'looks good to me' },
      }),
      APP_LOGIN,
    );
    expect(job).toBeUndefined();
  });

  it('treats a reply inside a review thread as new evidence', () => {
    const job = toReviewJob(
      delivery('pull_request_review_comment', {
        action: 'created',
        installation: { id: 7 },
        sender: { login: 'coding-agent' },
        repository: REPO,
        pull_request: { number: 12 },
        comment: { id: 99, in_reply_to_id: 42, body: 'fixed in the latest push', path: 'src/a.ts', line: 10 },
      }),
      APP_LOGIN,
    );

    expect(job).toMatchObject({ kind: 'verify', pullNumber: 12 });
    expect(job?.thread).toMatchObject({ commentId: 99, inReplyToId: 42, path: 'src/a.ts' });
    // Implicit: whether the thread is Half-Shell's is decided against state.
    expect(job?.thread?.implicit).toBe(true);
  });

  it('marks a commanded review comment as explicit', () => {
    const job = toReviewJob(
      delivery('pull_request_review_comment', {
        action: 'created',
        installation: { id: 7 },
        sender: { login: 'dev' },
        repository: REPO,
        pull_request: { number: 12 },
        comment: { id: 99, body: '@half-shell verify', path: 'src/a.ts', line: 10 },
      }),
      APP_LOGIN,
    );

    expect(job?.thread?.implicit).toBe(false);
  });

  it('ignores deliveries without an installation', () => {
    expect(
      toReviewJob(
        delivery('pull_request', {
          action: 'opened',
          sender: { login: 'dev' },
          repository: REPO,
          pull_request: { number: 12, draft: false },
        }),
        APP_LOGIN,
      ),
    ).toBeUndefined();
  });
});

describe('verifySignature', () => {
  const secret = 'shhh';
  const payload = '{"action":"opened"}';

  it('accepts a correctly signed payload', () => {
    expect(verifySignature(secret, payload, sign(secret, payload))).toBe(true);
  });

  it('rejects a tampered payload, a wrong secret and a missing header', () => {
    const signature = sign(secret, payload);
    expect(verifySignature(secret, '{"action":"closed"}', signature)).toBe(false);
    expect(verifySignature('other', payload, signature)).toBe(false);
    expect(verifySignature(secret, payload, undefined)).toBe(false);
    expect(verifySignature(secret, payload, 'sha1=abc')).toBe(false);
  });
});
