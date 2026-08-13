import { createSign } from 'node:crypto';

import type { GitHubConfig } from '../config.js';
import { log } from '../logger.js';
import type { ChangedFile, RepoRef } from '../types.js';

const MAX_ATTEMPTS = 4;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before retrying, or undefined when the failure is not
 * worth retrying.
 *
 * Rate limiting (429, and the two 403 forms) is rejected before GitHub does
 * any work, so it is always safe to retry. A 5xx is ambiguous — the write may
 * well have landed — so it is only retried for reads. Retrying a POST there
 * would risk a second review or a duplicate reply, which is exactly the noise
 * this service exists to avoid.
 */
export function retryDelayMs(
  response: { status: number; headers: { get(name: string): string | null } },
  detail: string,
  attempt: number,
  idempotent: boolean,
): number | undefined {
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (/secondary rate limit/i.test(detail) ||
        response.headers.get('x-ratelimit-remaining') === '0'));

  if (!rateLimited) {
    return response.status >= 500 && idempotent ? backoffMs(attempt) : undefined;
  }

  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 60_000);
  }

  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      const waitMs = reset * 1000 - Date.now();
      // Only wait out a primary rate limit if it clears reasonably soon.
      return waitMs > 0 && waitMs <= 60_000 ? waitMs : undefined;
    }
    return undefined;
  }

  return backoffMs(attempt);
}

/** App-level JWT used to exchange for short-lived installation tokens. */
export function createAppJwt(config: GitHubConfig, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(config.privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface ReviewComment {
  path: string;
  body: string;
  line?: number;
  start_line?: number;
  side?: 'LEFT' | 'RIGHT';
}

export class GitHubClient {
  private readonly tokens = new Map<number, CachedToken>();

  constructor(private readonly config: GitHubConfig) {}

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

    const response = await fetch(
      `${this.config.apiBaseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createAppJwt(this.config)}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `failed to mint installation token (${response.status}): ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, {
      token: payload.token,
      expiresAt: Date.parse(payload.expires_at),
    });
    return payload.token;
  }

  async request<T>(
    installationId: number,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastDetail = '';
    let lastStatus = 0;
    // A failed write may still have been applied, so only reads are replayed
    // on an ambiguous failure.
    const idempotent = method === 'GET';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const token = await this.installationToken(installationId);
      let response: Response;
      try {
        response = await fetch(`${this.config.apiBaseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        // A network failure or timeout on a write is ambiguous: GitHub may
        // have processed it and lost the response. Only reads are replayed.
        lastDetail = error instanceof Error ? error.message : String(error);
        if (!idempotent || attempt === MAX_ATTEMPTS) break;
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      lastStatus = response.status;
      lastDetail = (await response.text().catch(() => '')).slice(0, 500);

      const wait = retryDelayMs(response, lastDetail, attempt, idempotent);
      if (wait === undefined || attempt === MAX_ATTEMPTS) break;
      log.warn('retrying GitHub request', {
        method,
        path,
        status: response.status,
        attempt,
        waitMs: wait,
      });
      await delay(wait);
    }

    throw new Error(`GitHub ${method} ${path} failed (${lastStatus || 'network'}): ${lastDetail}`);
  }

  /** Follow `page` until a short page comes back, up to `maxPages`. */
  private async paginate<T>(
    installationId: number,
    path: string,
    perPage = 100,
    maxPages = 10,
  ): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.request<T[]>(
        installationId,
        'GET',
        `${path}${separator}per_page=${perPage}&page=${page}`,
      );
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (batch.length < perPage) break;
    }
    return items;
  }

  async getPullRequest(
    installationId: number,
    repo: RepoRef,
    number: number,
  ): Promise<PullRequestPayload> {
    return this.request<PullRequestPayload>(
      installationId,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}`,
    );
  }

  async listFiles(
    installationId: number,
    repo: RepoRef,
    number: number,
    maxFiles: number,
  ): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= 10 && files.length < maxFiles; page += 1) {
      const batch = await this.request<GitHubFilePayload[]>(
        installationId,
        'GET',
        `/repos/${repo.owner}/${repo.repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) break;
      for (const file of batch) {
        files.push({
          path: file.filename,
          previousPath: file.previous_filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
          truncated: file.patch === undefined && file.changes > 0,
        });
      }
      if (batch.length < 100) break;
    }
    return files;
  }

  async getFileContent(
    installationId: number,
    repo: RepoRef,
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    try {
      const payload = await this.request<{ content?: string; encoding?: string }>(
        installationId,
        'GET',
        `/repos/${repo.owner}/${repo.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
      );
      if (!payload.content) return undefined;
      return Buffer.from(payload.content, 'base64').toString('utf8');
    } catch (error) {
      log.debug('file not available', { path, ref, error: String(error) });
      return undefined;
    }
  }

  async getIssue(
    installationId: number,
    repo: RepoRef,
    number: number,
  ): Promise<{ number: number; title: string; body: string } | undefined> {
    try {
      const payload = await this.request<{ number: number; title: string; body: string | null }>(
        installationId,
        'GET',
        `/repos/${repo.owner}/${repo.repo}/issues/${number}`,
      );
      return { number: payload.number, title: payload.title, body: payload.body ?? '' };
    } catch {
      return undefined;
    }
  }

  /** Code search. Rate-limited and index-lagged; callers must tolerate failure. */
  async searchCode(
    installationId: number,
    query: string,
  ): Promise<{ path: string }[]> {
    const payload = await this.request<{ items?: { path: string }[] }>(
      installationId,
      'GET',
      `/search/code?q=${encodeURIComponent(query)}&per_page=10`,
    );
    return payload.items ?? [];
  }

  async createReview(
    installationId: number,
    repo: RepoRef,
    number: number,
    review: {
      body: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      commit_id?: string;
      comments?: ReviewComment[];
    },
  ): Promise<{ id: number }> {
    return this.request(
      installationId,
      'POST',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
      review,
    );
  }

  /** Every inline comment on the PR, across pages. */
  async listReviewComments(
    installationId: number,
    repo: RepoRef,
    number: number,
  ): Promise<{ id: number; path: string; line: number | null; body: string }[]> {
    return this.paginate(installationId, `/repos/${repo.owner}/${repo.repo}/pulls/${number}/comments`);
  }

  async createIssueComment(
    installationId: number,
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<{ id: number }> {
    return this.request(
      installationId,
      'POST',
      `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`,
      { body },
    );
  }

  async replyToReviewComment(
    installationId: number,
    repo: RepoRef,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    return this.request(
      installationId,
      'POST',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}/comments/${commentId}/replies`,
      { body },
    );
  }
}

export interface PullRequestPayload {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  user: { login: string } | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface GitHubFilePayload {
  filename: string;
  previous_filename?: string;
  status: ChangedFile['status'];
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
