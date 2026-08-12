import { HalfShellApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { PROTOCOL_VERSION } from './protocol/protocol.js';
import { createWebhookServer } from './server.js';

const config = loadConfig();

if (!config.github) {
  log.error('missing GITHUB_APP_ID, GITHUB_PRIVATE_KEY or GITHUB_WEBHOOK_SECRET');
  process.exit(1);
}
for (const problem of config.providerProblems) {
  log.warn('provider dropped from the chain', { problem });
}
if (config.providers.length === 0) {
  log.error('no usable inference providers', {
    chain: process.env['HALF_SHELL_PROVIDERS'] ?? '(unset)',
    problems: config.providerProblems,
  });
  process.exit(1);
}

const app = new HalfShellApp(config);
const server = createWebhookServer(app, config);

server.listen(config.port, () => {
  log.info('half-shell listening', {
    port: config.port,
    protocol: PROTOCOL_VERSION,
    providers: config.providers.map((provider) => `${provider.id}:${provider.tier}`),
    allowPaidInference: config.allowPaidInference,
    dryRun: config.review.dryRun,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down; draining in-flight reviews', { signal });
    server.close(() => {
      void app.idle().then(() => process.exit(0));
    });
    // Do not wait forever for a wedged provider call.
    setTimeout(() => process.exit(0), 30_000).unref();
  });
}
