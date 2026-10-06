/**
 * `npm run dojo` — starts the local, read-only Dojo v0 viewer (Issue #20)
 * over the Council orchestration database the service writes to
 * (HALF_SHELL_COUNCIL_DATABASE_PATH, default <HALF_SHELL_DATA_DIR>/council.db).
 *
 * Binds to 127.0.0.1 by default. Council transcripts can contain private
 * repository content and v0 has no authentication, so binding anything
 * other than loopback requires HALF_SHELL_DOJO_ALLOW_REMOTE=true and logs a
 * warning.
 */
import { existsSync } from 'node:fs';

import { log } from '../logger.js';
import { OrchestrationStore } from '../orchestration/store.js';
import type { DojoReader } from './readModel.js';
import { createDojoServer, isLoopbackHost, loopbackHosts } from './server.js';

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

const dataDir = env('HALF_SHELL_DATA_DIR') ?? '.half-shell';
const databasePath = env('HALF_SHELL_COUNCIL_DATABASE_PATH') ?? `${dataDir}/council.db`;
const host = env('HALF_SHELL_DOJO_HOST') ?? '127.0.0.1';
const portRaw = Number(env('HALF_SHELL_DOJO_PORT') ?? '3001');
const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3001;
const allowRemote = ['1', 'true', 'yes', 'on'].includes((env('HALF_SHELL_DOJO_ALLOW_REMOTE') ?? '').toLowerCase());
const loopback = isLoopbackHost(host);

if (!loopback && !allowRemote) {
  log.error('refusing to bind the Dojo viewer to a non-loopback host', {
    host,
    fix: 'use 127.0.0.1, or set HALF_SHELL_DOJO_ALLOW_REMOTE=true if you really mean to expose unauthenticated Council transcripts',
  });
  process.exit(1);
}
if (!loopback) {
  log.warn(
    'WARNING: Dojo v0 has NO authentication. Binding to a non-loopback host exposes every Council transcript in this database — including private-repository content — to anyone who can reach this address.',
    { host, port },
  );
}

// Opened lazily and read-only: the database may not exist until the first
// council review runs, and the viewer must never create or migrate it.
let store: OrchestrationStore | undefined;
function getReader(): DojoReader | undefined {
  if (store) return store;
  if (!existsSync(databasePath)) return undefined;
  try {
    store = new OrchestrationStore(databasePath, { readOnly: true });
    return store;
  } catch (error) {
    log.warn('could not open Council database read-only yet', {
      databasePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const server = createDojoServer({
  getReader,
  databasePath,
  allowedHosts: loopback ? loopbackHosts(port, host) : undefined,
});

server.listen(port, host, () => {
  const shownHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${shownHost}:${port}/dojo`;
  log.info('dojo viewer listening (read-only)', { url, databasePath, exists: existsSync(databasePath) });
  process.stdout.write(`\nHalf-Shell Dojo (read-only): ${url}\nReading Council DB: ${databasePath}\n\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    store?.close();
    process.exit(0);
  });
}
