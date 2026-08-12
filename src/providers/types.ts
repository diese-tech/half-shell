/**
 * `paid` providers are never used unless the operator explicitly opts in.
 * Half-Shell must never silently spend money on inference.
 */
export type ProviderTier = 'free' | 'local' | 'paid';

export interface ProviderConfig {
  id: string;
  tier: ProviderTier;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Hint that the response must be a single JSON value. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
}

export interface Provider {
  readonly id: string;
  readonly tier: ProviderTier;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
