import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HalfShellApp } from './app.js';
import type { Config } from './config.js';
import { toReviewJob } from './github/events.js';
import { verifySignature } from './github/signature.js';
import { log, errorFields } from './logger.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('webhook payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(payload);
}

export function createWebhookServer(app: HalfShellApp, config: Config): Server {
  const secret = config.github?.webhookSecret;
  const appLogin = config.github?.appLogin ?? 'half-shell[bot]';

  return createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/healthz') {
        send(response, 200, { status: 'ok', providers: config.providers.map((p) => p.id) });
        return;
      }
      if (request.method !== 'POST' || !request.url?.startsWith('/webhook')) {
        send(response, 404, { error: 'not found' });
        return;
      }
      if (!secret) {
        send(response, 500, { error: 'webhook secret is not configured' });
        return;
      }

      let raw: Buffer;
      try {
        raw = await readBody(request);
      } catch (error) {
        send(response, 413, { error: error instanceof Error ? error.message : 'bad request' });
        return;
      }

      const signature = request.headers['x-hub-signature-256'];
      if (!verifySignature(secret, raw, typeof signature === 'string' ? signature : undefined)) {
        log.warn('rejected webhook with an invalid signature');
        send(response, 401, { error: 'invalid signature' });
        return;
      }

      const event = String(request.headers['x-github-event'] ?? '');
      const deliveryId = String(request.headers['x-github-delivery'] ?? '');
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        send(response, 400, { error: 'invalid JSON payload' });
        return;
      }

      const job = toReviewJob({ event, deliveryId, payload }, appLogin);
      // Acknowledge before working: GitHub expects a fast response.
      send(response, 202, { accepted: Boolean(job), event, delivery: deliveryId });
      if (!job) return;

      log.info('accepted delivery', {
        event,
        delivery: deliveryId,
        kind: job.kind,
        pr: job.pullNumber,
      });
      app.enqueue(job).catch((error) => log.error('job rejected', errorFields(error)));
    })().catch((error) => {
      log.error('request handling failed', errorFields(error));
      if (!response.headersSent) send(response, 500, { error: 'internal error' });
    });
  });
}
