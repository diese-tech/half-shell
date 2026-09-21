/**
 * Wires the council orchestration engine (src/orchestration/engine.ts) into
 * real webhook-derived review jobs. This is the production adapter for
 * HALF_SHELL_REVIEW_ENGINE=council — see src/engine/router.ts for how a
 * job actually reaches this class, and src/app.ts for the equivalent v1
 * adapter. Mirrors HalfShellApp's per-PR queueing so a push cannot
 * interleave two reviews of the same pull request, but everything below
 * that boundary is engine.ts's own state machine: this class only gathers
 * the change context, builds the webhook-shaped input, and calls ingest().
 */
import type { Config } from '../config.js';
import { buildChangeContext } from '../github/context.js';
import { GitHubClient } from '../github/client.js';
import { log, errorFields } from '../logger.js';
import type { PersonaConfig } from '../personas/types.js';
import { loadPersonas } from '../personas/loader.js';
import { ProviderRouter } from '../providers/router.js';
import type { ReviewJob } from '../types.js';
import { renderChange } from '../council/prompt.js';
import { ingest, type EngineDependencies, type WebhookIngestInput } from './engine.js';
import type { PublicationGitHubClient } from './phases/publication.js';
import { poolFromSingleChain } from './provider.js';
import { untrustedInput } from './prompt.js';
import { OrchestrationStore } from './store.js';
import type { PersonaCodename } from './types.js';

/** Every persona resolves to the same provider chain today (see provider.ts) — these three labels just document the intended tiers from config/council/orchestration.yaml's model_routing. */
const CAPABILITY_TIERS = ['local_or_free', 'stronger_reasoning_model', 'strongest_available_model'];

export interface CouncilAppDependencies {
  client?: GitHubClient;
  store?: OrchestrationStore;
  personas?: Map<string, PersonaConfig>;
  createRouter?: () => ProviderRouter;
}

export class CouncilApp {
  private readonly client: GitHubClient;
  private readonly store: OrchestrationStore;
  private personas: Map<string, PersonaConfig> | undefined;
  private readonly createRouter: () => ProviderRouter;
  /** One in-flight job per pull request; later deliveries queue behind it. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    dependencies: CouncilAppDependencies = {},
  ) {
    if (!config.github && !dependencies.client) {
      throw new Error('GitHub App credentials are not configured');
    }
    this.client = dependencies.client ?? new GitHubClient(config.github!);
    this.store = dependencies.store ?? new OrchestrationStore(config.councilDatabasePath);
    this.personas = dependencies.personas;
    this.createRouter =
      dependencies.createRouter ??
      (() => ProviderRouter.fromConfig(config.providers, { allowPaid: config.allowPaidInference }));
  }

  enqueue(job: ReviewJob): Promise<void> {
    if (job.kind !== 'review') {
      // Targeted finding verification/reconsideration and `explain` are not
      // yet implemented against the council engine — see the PR description
      // for this known gap. Those job kinds still reach the user through
      // src/engine/router.ts routing them to v1 regardless of engine
      // selection; this guard only protects a CouncilApp used directly.
      log.info('council engine has no lane for this job kind yet; skipping', {
        kind: job.kind,
        pr: job.pullNumber,
      });
      return Promise.resolve();
    }
    const key = `${job.repo.owner}/${job.repo.repo}#${job.pullNumber}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.review(job))
      .catch((error) => log.error('council job failed', { key, ...errorFields(error) }));
    this.queues.set(key, next);
    return next;
  }

  /** Resolves once every queued job has finished. Used for graceful shutdown. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) {
      const pending = [...this.queues.values()];
      await Promise.allSettled(pending);
      for (const [key, promise] of this.queues) {
        if (pending.includes(promise)) this.queues.delete(key);
      }
    }
  }

  private async personaConfigs(): Promise<Map<string, PersonaConfig>> {
    this.personas ??= await loadPersonas(this.config.personasDir);
    return this.personas;
  }

  private async review(job: ReviewJob): Promise<void> {
    const router = this.createRouter();
    if (router.isEmpty) {
      log.error('no usable inference providers; skipping council review', { pr: job.pullNumber });
      return;
    }

    const personas = await this.personaConfigs();
    const pool = poolFromSingleChain(router, CAPABILITY_TIERS, 'local_or_free');
    const providerFor = (persona: PersonaCodename) => pool.forPersona(persona);

    const context = await buildChangeContext(
      this.client,
      job.installationId,
      job.repo,
      job.pullNumber,
      this.config.review,
    );
    if (context.files.length === 0) {
      log.info('no reviewable files in change', { pr: job.pullNumber });
      return;
    }

    const change = renderChange(context, {
      maxPatchChars: this.config.review.maxPatchChars,
      maxTotalChars: this.config.review.maxPromptChars,
    });

    const repositoryId = `${job.repo.owner}/${job.repo.repo}`;
    const githubClient: PublicationGitHubClient = this.config.review.dryRun
      ? dryRunPublicationClient(this.client)
      : this.client;

    const deps: EngineDependencies = { store: this.store, personas, providerFor, githubClient };
    const input: WebhookIngestInput = {
      repositoryId,
      repositoryFullName: repositoryId,
      pullRequestNumber: job.pullNumber,
      baseSha: context.baseSha,
      headSha: context.headSha,
      installationId: job.installationId,
      repo: job.repo,
      githubDeliveryId: job.deliveryId,
      trigger: 'webhook',
      // Attacker-controlled PR content (title, description, diff, linked
      // issues, repository guidance) is delimited and paired with the
      // explicit non-authority rule personaSystemPrompt() carries, exactly
      // as v1's pipeline does for the same content (src/council/briefing.ts,
      // src/council/lanes.ts) — never handed to a persona as if it were an
      // instruction.
      changeContext: untrustedInput('github_pull_request', change.text),
    };

    const result = await ingest(deps, input);
    log.info('council review ingested', {
      pr: job.pullNumber,
      reviewId: result.reviewId,
      outcome: result.outcome,
    });
  }
}

/**
 * Everything up to and including the head-SHA check still runs for real in
 * dry-run mode — only the actual GitHub mutation is suppressed — matching
 * how v1's dry run behaves in src/app.ts.
 */
function dryRunPublicationClient(client: GitHubClient): PublicationGitHubClient {
  return {
    getPullRequest: (installationId, repo, pullNumber) =>
      client.getPullRequest(installationId, repo, pullNumber),
    async createReview(_installationId, _repo, pullNumber, review) {
      log.info('dry run; council review not posted', {
        pullNumber,
        event: review.event,
        body: review.body,
      });
      return { id: -1 };
    },
  };
}
