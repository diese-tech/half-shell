/**
 * `npm run local` — one command for a local Council session:
 *
 *   1. loads ./.env if present;
 *   2. defaults to the Council engine on local Ollama (qwen2.5-coder:14b);
 *   3. starts `ollama serve` if it isn't running and loads the model;
 *   4. starts the read-only Dojo viewer;
 *   5. starts the webhook service (needs GitHub App credentials), or with
 *      `--harness` runs one sample Council review against stub GitHub so
 *      there is something to watch without any credentials.
 *
 * Ctrl+C stops everything it started, including Ollama if this launcher
 * was the one that started it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ensureOllama } from './ollama.js';

const DEFAULT_MODEL = 'qwen2.5-coder:14b';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434/v1';

function say(message: string): void {
  process.stdout.write(`[local] ${message}\n`);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function setDefault(name: string, value: string): void {
  if (env(name) === undefined) process.env[name] = value;
}

const harnessMode = process.argv.includes('--harness');

if (existsSync('.env')) {
  process.loadEnvFile('.env');
  say('loaded .env');
}

setDefault('HALF_SHELL_REVIEW_ENGINE', 'council');
setDefault('HALF_SHELL_PROVIDERS', 'ollama');
setDefault('HALF_SHELL_PROVIDER_OLLAMA_MODEL', DEFAULT_MODEL);
setDefault('HALF_SHELL_PROVIDER_OLLAMA_BASE_URL', DEFAULT_OLLAMA_URL);

const model = env('HALF_SHELL_PROVIDER_OLLAMA_MODEL')!;
const ollamaUrl = env('HALF_SHELL_PROVIDER_OLLAMA_BASE_URL')!;
const providers = env('HALF_SHELL_PROVIDERS')!.split(',').map((p) => p.trim().toLowerCase());
const dataDir = env('HALF_SHELL_DATA_DIR') ?? '.half-shell';
const councilDb = env('HALF_SHELL_COUNCIL_DATABASE_PATH') ?? `${dataDir}/council.db`;

const script = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const children: ChildProcess[] = [];
let ollama: ChildProcess | undefined;

function run(name: string, file: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [file], { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  children.push(child);
  child.on('exit', (code) => say(`${name} exited (${code ?? 'signal'})`));
  return child;
}

function shutdown(code: number): never {
  for (const child of children) child.kill();
  if (ollama) {
    say('stopping the Ollama server this launcher started');
    ollama.kill();
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(0));

async function main(): Promise<void> {
  if (providers.includes('ollama') || harnessMode) {
    const result = await ensureOllama({ baseUrl: ollamaUrl, model, log: say });
    ollama = result.started;
  } else {
    say(`HALF_SHELL_PROVIDERS=${providers.join(',')} does not include ollama; not starting it`);
  }

  run('dojo', script('../dojo/main.js'));

  if (harnessMode) {
    say(`running one sample Council review on ${model} (stub GitHub, real Ollama) — watch it in Dojo`);
    run('harness', script('../harness/run.js'), {
      HALF_SHELL_REVIEW_ENGINE: 'council',
      HALF_SHELL_HARNESS_OLLAMA_MODEL: model,
      HALF_SHELL_HARNESS_OLLAMA_URL: ollamaUrl,
      HALF_SHELL_HARNESS_COUNCIL_DATABASE_PATH: councilDb,
    }).on('exit', () => say('sample review finished; Dojo is still running — Ctrl+C to stop'));
    return;
  }

  if (!env('GITHUB_APP_ID') || !env('GITHUB_PRIVATE_KEY') || !env('GITHUB_WEBHOOK_SECRET')) {
    say('no GitHub App credentials in the environment/.env, so the webhook service is not started.');
    say('Dojo is running. For a credential-free Council run on Ollama, use: npm run local -- --harness');
    return;
  }
  run('half-shell', script('../index.js'));
}

main().catch((error) => {
  process.stderr.write(`[local] ${error instanceof Error ? error.message : String(error)}\n`);
  shutdown(1);
});
