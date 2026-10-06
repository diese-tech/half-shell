/**
 * Makes sure a local Ollama server is up and the configured model is loaded
 * before a local Council run starts — used only by `npm run local`
 * (src/local/main.ts), never by the production service.
 *
 * It starts `ollama serve` only when nothing answers on a loopback URL; it
 * never touches a remote Ollama, and it never pulls a model (a pull can be
 * many GB — that stays a deliberate `ollama pull`).
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { isLoopbackHost } from '../dojo/server.js';

export interface EnsureOllamaOptions {
  /** OpenAI-compatible base URL Half-Shell calls, e.g. http://127.0.0.1:11434/v1. */
  baseUrl: string;
  model: string;
  /** How long to wait for a freshly started server to answer. */
  startTimeoutMs?: number;
  /** How long Ollama should keep the model loaded after the warm-up. */
  keepAlive?: string;
  log?: (message: string) => void;
}

export interface EnsureOllamaDependencies {
  fetch?: typeof fetch;
  spawnServe?: () => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureOllamaResult {
  /** The process this call started, or undefined if Ollama was already running. */
  started: ChildProcess | undefined;
  nativeUrl: string;
}

/** Ollama's native API lives at the server root; Half-Shell's provider URL carries /v1. */
export function nativeOllamaUrl(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** `qwen2.5` and `qwen2.5:latest` are the same model to Ollama. */
export function hasModel(installed: string[], model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return installed.some((name) => name === model || name === wanted);
}

function defaultSpawnServe(): ChildProcess {
  return spawn('ollama', ['serve'], { stdio: 'ignore', windowsHide: true });
}

async function listModels(fetchImpl: typeof fetch, nativeUrl: string): Promise<string[] | undefined> {
  try {
    const response = await fetchImpl(`${nativeUrl}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
    return (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => Boolean(n));
  } catch {
    return undefined;
  }
}

export async function ensureOllama(
  options: EnsureOllamaOptions,
  dependencies: EnsureOllamaDependencies = {},
): Promise<EnsureOllamaResult> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => undefined);
  const nativeUrl = nativeOllamaUrl(options.baseUrl);

  let models = await listModels(fetchImpl, nativeUrl);
  let started: ChildProcess | undefined;

  if (!models) {
    if (!isLoopbackHost(new URL(nativeUrl).hostname)) {
      throw new Error(`Ollama is not reachable at ${nativeUrl}, and it is not local, so it will not be started automatically.`);
    }
    log(`Ollama is not running at ${nativeUrl}; starting \`ollama serve\`...`);
    const child = (dependencies.spawnServe ?? defaultSpawnServe)();
    started = child;
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });

    const deadline = Date.now() + (options.startTimeoutMs ?? 30_000);
    while (!models && Date.now() < deadline) {
      if (spawnError) break;
      await sleep(500);
      models = await listModels(fetchImpl, nativeUrl);
    }
    if (!models) {
      child.kill();
      const reason = spawnError
        ? `could not run \`ollama\` (${spawnError.message}) — is Ollama installed and on PATH?`
        : 'it did not answer in time';
      throw new Error(`Ollama failed to start at ${nativeUrl}: ${reason}`);
    }
    log('Ollama is up.');
  } else {
    log(`Ollama already running at ${nativeUrl}.`);
  }

  if (!hasModel(models, options.model)) {
    throw new Error(
      `Ollama does not have "${options.model}" pulled (installed: ${models.join(', ') || 'none'}). Run \`ollama pull ${options.model}\` first.`,
    );
  }

  // An empty prompt makes Ollama load the model into memory without generating,
  // so the first persona turn doesn't also pay the model-load time.
  log(`Loading ${options.model} into memory...`);
  const warm = await fetchImpl(`${nativeUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: options.model, prompt: '', keep_alive: options.keepAlive ?? '30m' }),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!warm.ok) {
    throw new Error(`Ollama could not load ${options.model}: HTTP ${warm.status} ${await warm.text()}`);
  }
  log(`${options.model} is loaded.`);

  return { started, nativeUrl };
}
