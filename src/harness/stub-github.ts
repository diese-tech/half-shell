import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ChangedFile } from '../types.js';
import { closeServer } from './stub-inference.js';

/**
 * The slice of the GitHub REST API that Half-Shell uses, backed by memory.
 * Records everything the service posts so a test can assert on it.
 */
export interface StubPullRequest {
  number: number;
  title: string;
  body: string;
  draft?: boolean;
  author?: string;
  headSha: string;
  baseSha: string;
  files: ChangedFile[];
}

export interface PostedReview {
  body: string;
  event: string;
  commit_id?: string;
  comments: { path: string; line?: number; start_line?: number; side?: string; body: string }[];
}

export interface PostedInlineComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  in_reply_to_id?: number;
}

export interface StubGitHub {
  url: string;
  reviews: PostedReview[];
  issueComments: string[];
  inlineComments: PostedInlineComment[];
  replies: { commentId: number; body: string }[];
  /** Files served by the contents endpoint, keyed by path. */
  contents: Map<string, string>;
  setPullRequest(pr: StubPullRequest): void;
  /** Requests received, for asserting on pagination and retries. */
  requests: { method: string; path: string }[];
  /** Paths that should fail with the given status before succeeding. */
  failures: Map<string, { status: number; times: number }>;
  close(): Promise<void>;
}

export async function startStubGitHub(initial: StubPullRequest): Promise<StubGitHub> {
  let pullRequest = initial;
  const reviews: PostedReview[] = [];
  const issueComments: string[] = [];
  const inlineComments: PostedInlineComment[] = [];
  const replies: { commentId: number; body: string }[] = [];
  const contents = new Map<string, string>();
  const requests: { method: string; path: string }[] = [];
  const failures = new Map<string, { status: number; times: number }>();
  let nextCommentId = 1000;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      requests.push({ method, path });

      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      const failure = failures.get(`${method} ${path}`);
      if (failure && failure.times > 0) {
        failure.times -= 1;
        send(failure.status, { message: 'simulated failure' });
        return;
      }

      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

      // POST /app/installations/:id/access_tokens
      if (method === 'POST' && /\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        send(201, {
          token: 'ghs_stub_token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        return;
      }

      // GET /repos/:owner/:repo/pulls/:number
      if (method === 'GET' && /\/pulls\/\d+$/.test(path)) {
        send(200, {
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body,
          draft: pullRequest.draft ?? false,
          user: { login: pullRequest.author ?? 'dev' },
          head: { sha: pullRequest.headSha, ref: 'feature' },
          base: { sha: pullRequest.baseSha, ref: 'main' },
        });
        return;
      }

      // GET /repos/:owner/:repo/pulls/:number/files
      if (method === 'GET' && path.endsWith('/files')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        send(
          200,
          page > 1
            ? []
            : pullRequest.files.map((file) => ({
                filename: file.path,
                previous_filename: file.previousPath,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.additions + file.deletions,
                patch: file.patch,
              })),
        );
        return;
      }

      // GET/POST /repos/:owner/:repo/pulls/:number/comments
      if (path.endsWith('/pulls/' + pullRequest.number + '/comments')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        send(200, page > 1 ? [] : inlineComments);
        return;
      }

      // POST /repos/:owner/:repo/pulls/:number/comments/:id/replies
      if (method === 'POST' && /\/comments\/\d+\/replies$/.test(path)) {
        const commentId = Number(path.split('/').at(-2));
        replies.push({ commentId, body: String(body.body ?? '') });
        nextCommentId += 1;
        inlineComments.push({
          id: nextCommentId,
          path: inlineComments.find((c) => c.id === commentId)?.path ?? '',
          line: null,
          body: String(body.body ?? ''),
          in_reply_to_id: commentId,
        });
        send(201, { id: nextCommentId });
        return;
      }

      // POST /repos/:owner/:repo/pulls/:number/reviews
      if (method === 'POST' && path.endsWith('/reviews')) {
        const review: PostedReview = {
          body: String(body.body ?? ''),
          event: String(body.event ?? ''),
          commit_id: body.commit_id,
          comments: body.comments ?? [],
        };
        reviews.push(review);
        for (const comment of review.comments) {
          nextCommentId += 1;
          inlineComments.push({
            id: nextCommentId,
            path: comment.path,
            line: comment.line ?? null,
            body: comment.body,
          });
        }
        send(200, { id: reviews.length });
        return;
      }

      // POST /repos/:owner/:repo/issues/:number/comments
      if (method === 'POST' && path.includes('/issues/') && path.endsWith('/comments')) {
        issueComments.push(String(body.body ?? ''));
        send(201, { id: issueComments.length });
        return;
      }

      // GET /repos/:owner/:repo/contents/:path
      if (method === 'GET' && path.includes('/contents/')) {
        const file = decodeURIComponent(path.split('/contents/')[1] ?? '');
        const content = contents.get(file);
        if (content === undefined) {
          send(404, { message: 'Not Found' });
          return;
        }
        send(200, { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' });
        return;
      }

      // GET /search/code
      if (method === 'GET' && path === '/search/code') {
        send(200, { items: [] });
        return;
      }

      // GET /repos/:owner/:repo/issues/:number
      if (method === 'GET' && /\/issues\/\d+$/.test(path)) {
        send(404, { message: 'Not Found' });
        return;
      }

      send(404, { message: `unhandled ${method} ${path}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    reviews,
    issueComments,
    inlineComments,
    replies,
    contents,
    requests,
    failures,
    setPullRequest: (pr) => {
      pullRequest = pr;
    },
    close: () => closeServer(server),
  };
}
