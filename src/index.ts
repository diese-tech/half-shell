import { HalfShellApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { CouncilApp } from './orchestration/app.js';
import { PROTOCOL_VERSION } from './protocol/protocol.js';
import { ReviewEngineRouter } from './reviewEngine.js';
import { createWebhookServer } from './server.js';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  log.error('invalid configuration', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

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

// v1 remains available regardless of selection — it is the operational
// fallback, not dead code (docs/architecture/review-policy.md section 21).
// The council engine is only constructed (persona YAML loaded, its own
// store opened) when actually selected, so a v1-only deployment carries no
// extra startup cost or failure mode from council-only prerequisites.
const v1 = new HalfShellApp(config);
const council = config.reviewEngine === 'council' ? new CouncilApp(config) : undefined;
const app = new ReviewEngineRouter(v1, council, config.reviewEngine);
const server = createWebhookServer(app, config);

server.listen(config.port, () => {
  log.info('half-shell listening', {
    port: config.port,
    protocol: PROTOCOL_VERSION,
    reviewEngine: config.reviewEngine,
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
