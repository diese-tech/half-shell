import { log, errorFields } from '../logger.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
} from './types.js';

export interface RouterOptions {
  allowPaid: boolean;
  attemptsPerProvider?: number;
}

/**
 * Ordered fallback chain: free cloud, then alternate free cloud, then local
 * inference. Paid tiers stay out of the chain unless explicitly enabled.
 */
export interface RouterTelemetry {
  /** Completions that returned successfully. */
  calls: number;
  /** Attempts that failed, including ones a later provider recovered from. */
  failures: number;
  promptTokens: number;
  completionTokens: number;
  /** Milliseconds spent waiting on providers, including failed attempts. */
  latencyMs: number;
}

export class ProviderRouter {
  private readonly chain: Provider[];
  private readonly usedIds = new Set<string>();
  private readonly telemetry: RouterTelemetry = {
    calls: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
  };

  constructor(
    providers: Provider[],
    private readonly options: RouterOptions,
  ) {
    const skipped = providers.filter((p) => p.tier === 'paid' && !options.allowPaid);
    for (const provider of skipped) {
      log.warn('skipping paid provider; HALF_SHELL_ALLOW_PAID_INFERENCE is not enabled', {
        provider: provider.id,
      });
    }
    this.chain = providers.filter((p) => p.tier !== 'paid' || options.allowPaid);
  }

  static fromConfig(configs: ProviderConfig[], options: RouterOptions): ProviderRouter {
    // Groq, OpenRouter and Ollama all speak the OpenAI chat-completions
    // shape, so one client covers the whole chain.
    const providers = configs.map((config) => new OpenAICompatibleProvider(config));
    return new ProviderRouter(providers, options);
  }

  get isEmpty(): boolean {
    return this.chain.length === 0;
  }

  /** Provider ids that actually served a completion during this run. */
  get used(): string[] {
    return [...this.usedIds];
  }

  /** Cost and latency accounting for everything this router has served. */
  get stats(): RouterTelemetry {
    return { ...this.telemetry };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.chain.length === 0) {
      throw new Error('no inference providers are configured');
    }
    const attempts = this.options.attemptsPerProvider ?? 2;
    const failures: string[] = [];

    for (const provider of this.chain) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const startedAt = Date.now();
        try {
          const result = await provider.complete(request);
          this.usedIds.add(provider.id);
          this.telemetry.calls += 1;
          this.telemetry.latencyMs += Date.now() - startedAt;
          this.telemetry.promptTokens += result.usage?.prompt ?? 0;
          this.telemetry.completionTokens += result.usage?.completion ?? 0;
          return result;
        } catch (error) {
          this.telemetry.failures += 1;
          this.telemetry.latencyMs += Date.now() - startedAt;
          const retryable = error instanceof ProviderError ? error.retryable : false;
          failures.push(error instanceof Error ? error.message : String(error));
          log.warn('provider attempt failed', {
            provider: provider.id,
            attempt,
            retryable,
            ...errorFields(error),
          });
          if (!retryable) break;
          if (attempt < attempts) await delay(500 * attempt);
        }
      }
    }
    throw new Error(`all providers failed: ${failures.join(' | ')}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
