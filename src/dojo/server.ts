/**
 * Dojo v0 HTTP server (Issue #20). GET/HEAD only, fixed routes, no SQL or
 * filter input reaches the store — the only request-derived value it ever
 * passes down is a review ID to an existing parameterized per-review read.
 * Nothing here can trigger a review, alter a verdict, resolve a finding,
 * or touch GitHub.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';

import { errorFields, log } from '../logger.js';
import { getRunDetail, listRunSummaries, type DojoReader } from './readModel.js';
import {
  DOJO_CSS,
  DOJO_JS,
  renderHome,
  renderHomeFragment,
  renderMissingDatabase,
  renderMissingDatabaseFragment,
  renderNotFound,
  renderRun,
  renderRunFragment,
} from './render.js';

export const RECENT_RUN_LIMIT = 50;

export interface DojoServerOptions {
  /** Returns the read-only store, or undefined while the database file does not exist yet. */
  getReader: () => DojoReader | undefined;
  databasePath: string;
  /**
   * Host header values accepted (e.g. "127.0.0.1:3001"). Undefined accepts
   * any — only used when the operator explicitly opted into non-loopback
   * binding. On loopback this blocks DNS-rebinding reads from a browser tab.
   */
  allowedHosts?: ReadonlySet<string>;
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(response: ServerResponse, request: IncomingMessage, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS });
  response.end(request.method === 'HEAD' ? undefined : body);
}

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '::1') return true;
  return isIP(bare) === 4 && bare.startsWith('127.');
}

/** Host header values a loopback-bound Dojo accepts. */
export function loopbackHosts(port: number, boundHost = '127.0.0.1'): Set<string> {
  const bound = boundHost.includes(':') && !boundHost.startsWith('[') ? `[${boundHost}]` : boundHost;
  return new Set(['127.0.0.1', 'localhost', '[::1]', bound.toLowerCase()].flatMap((h) => [h, `${h}:${port}`]));
}

export function createDojoServer(options: DojoServerOptions): Server {
  return createServer((request, response) => {
    void handle(options, request, response).catch((error) => {
      log.error('dojo request failed', errorFields(error));
      if (!response.headersSent) send(response, request, 500, 'text/plain; charset=utf-8', 'internal error');
      else response.end();
    });
  });
}

async function handle(options: DojoServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('allow', 'GET, HEAD');
    send(response, request, 405, 'text/plain; charset=utf-8', 'Dojo is read-only');
    return;
  }
  if (options.allowedHosts && !options.allowedHosts.has(String(request.headers.host ?? '').toLowerCase())) {
    send(response, request, 403, 'text/plain; charset=utf-8', 'unexpected Host header');
    return;
  }

  const url = new URL(request.url ?? '/', 'http://dojo.local');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const fragment = url.searchParams.get('fragment') === '1';

  if (path === '/') {
    response.writeHead(302, { location: '/dojo', ...SECURITY_HEADERS });
    response.end();
    return;
  }
  if (path === '/dojo/assets/dojo.css') return send(response, request, 200, 'text/css; charset=utf-8', DOJO_CSS);
  if (path === '/dojo/assets/dojo.js') return send(response, request, 200, 'text/javascript; charset=utf-8', DOJO_JS);
  if (path === '/healthz') return send(response, request, 200, JSON_TYPE, JSON.stringify({ status: 'ok' }));

  const reader = options.getReader();

  if (path === '/dojo') {
    if (!reader) {
      const body = fragment ? renderMissingDatabaseFragment(options.databasePath) : renderMissingDatabase(options.databasePath);
      return send(response, request, 200, HTML, body);
    }
    const runs = await listRunSummaries(reader, RECENT_RUN_LIMIT);
    return send(response, request, 200, HTML, fragment ? renderHomeFragment(runs, options.databasePath) : renderHome(runs, options.databasePath));
  }

  if (path === '/dojo/api/runs') {
    const runs = reader ? await listRunSummaries(reader, RECENT_RUN_LIMIT) : [];
    return send(response, request, 200, JSON_TYPE, JSON.stringify({ databasePath: options.databasePath, runs }));
  }

  const runMatch = /^\/dojo\/(api\/)?runs\/([^/]+)$/.exec(path);
  if (runMatch) {
    const api = Boolean(runMatch[1]);
    let reviewId: string;
    try {
      reviewId = decodeURIComponent(runMatch[2]!);
    } catch {
      return send(response, request, 400, 'text/plain; charset=utf-8', 'bad review id');
    }
    const detail = reader ? await getRunDetail(reader, reviewId) : undefined;
    if (!detail) {
      return api
        ? send(response, request, 404, JSON_TYPE, JSON.stringify({ error: 'review not found' }))
        : send(response, request, 404, HTML, renderNotFound(`No Council run with id ${reviewId}.`));
    }
    if (api) return send(response, request, 200, JSON_TYPE, JSON.stringify(detail));
    return send(response, request, 200, HTML, fragment ? renderRunFragment(detail) : renderRun(detail));
  }

  return send(response, request, 404, HTML, renderNotFound(`Nothing at ${path}.`));
}
