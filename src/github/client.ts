import { createSign } from 'node:crypto';

import type { GitHubConfig } from '../config.js';
import { log } from '../logger.js';
import type { ChangedFile, RepoRef } from '../types.js';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
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
    const token = await this.installationToken(installationId);
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
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
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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

  async createReview(
    installationId: number,
    repo: RepoRef,
    number: number,
    review: { body: string; event: 'COMMENT'; commit_id?: string; comments?: ReviewComment[] },
  ): Promise<{ id: number }> {
    return this.request(
      installationId,
      'POST',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`,
      review,
    );
  }

  /** Inline comments already on the PR, newest page last. */
  async listReviewComments(
    installationId: number,
    repo: RepoRef,
    number: number,
  ): Promise<{ id: number; path: string; line: number | null; body: string }[]> {
    return this.request(
      installationId,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls/${number}/comments?per_page=100`,
    );
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
