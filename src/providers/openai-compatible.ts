import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
} from './types.js';

/**
 * Chat-completions client for any OpenAI-shaped endpoint. Groq, OpenRouter,
 * llama.cpp servers, vLLM and Ollama's compatibility API all speak this.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly tier;
  readonly model: string;

  constructor(private readonly config: ProviderConfig) {
    this.id = config.id;
    this.tier = config.tier;
    this.model = config.model;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: request.temperature ?? 0.1,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };
    if (request.maxTokens) body['max_tokens'] = request.maxTokens;
    if (request.json) body['response_format'] = { type: 'json_object' };

    let response = await this.send(body);

    // Not every OpenAI-compatible endpoint accepts response_format. Losing a
    // whole lane to that is worse than parsing JSON out of prose ourselves.
    if (response.status === 400 && body['response_format']) {
      const detail = await response.text().catch(() => '');
      if (detail.includes('response_format')) {
        delete body['response_format'];
        response = await this.send(body);
      } else {
        throw new ProviderError(
          `${this.id} responded 400: ${detail.slice(0, 500)}`,
          this.id,
          false,
        );
      }
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new ProviderError(
        `${this.id} responded ${response.status}: ${detail}`,
        this.id,
        response.status === 429 || response.status >= 500,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError(`${this.id} returned an empty completion`, this.id, true);

    const usage = payload.usage
      ? {
          prompt: Number(payload.usage.prompt_tokens ?? 0),
          completion: Number(payload.usage.completion_tokens ?? 0),
        }
      : undefined;

    return { text, provider: this.id, model: this.config.model, usage };
  }

  private async send(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) headers['authorization'] = `Bearer ${this.config.apiKey}`;

    try {
      return await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
      });
    } catch (error) {
      throw new ProviderError(
        `${this.id} request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.id,
        true,
      );
    }
  }
}
