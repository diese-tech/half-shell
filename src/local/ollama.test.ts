import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { ensureOllama, hasModel, nativeOllamaUrl } from './ollama.js';

const BASE = 'http://127.0.0.1:11434/v1';
const MODEL = 'qwen2.5-coder:14b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake Ollama: `up` decides whether /api/tags answers. Records every call. */
function fakeOllama(state: { up: boolean; models?: string[] }) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!state.up) throw new TypeError('fetch failed');
    if (url.endsWith('/api/tags')) return json({ models: (state.models ?? [MODEL]).map((name) => ({ name, model: name })) });
    if (url.endsWith('/api/generate')) return json({ done: true });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  return child;
}

const noSleep = async () => undefined;

describe('ensureOllama', () => {
  it('does not start anything when Ollama is already running, and preloads the model', async () => {
    const { fetchImpl, calls } = fakeOllama({ up: true });
    const spawnServe = vi.fn(fakeChild);
    const result = await ensureOllama({ baseUrl: BASE, model: MODEL }, { fetch: fetchImpl, spawnServe, sleep: noSleep });

    expect(spawnServe).not.toHaveBeenCalled();
    expect(result.started).toBeUndefined();
    const warm = calls.find((c) => c.url === 'http://127.0.0.1:11434/api/generate');
    expect(warm?.body).toMatchObject({ model: MODEL, prompt: '' });
  });

  it('starts `ollama serve` when nothing answers locally, then waits for it', async () => {
    const state = { up: false };
    const { fetchImpl } = fakeOllama(state);
    const child = fakeChild();
    const spawnServe = vi.fn(() => {
      state.up = true;
      return child;
    });
    const result = await ensureOllama({ baseUrl: BASE, model: MODEL }, { fetch: fetchImpl, spawnServe, sleep: noSleep });

    expect(spawnServe).toHaveBeenCalledOnce();
    expect(result.started).toBe(child);
  });

  it('never starts a server for a remote Ollama URL', async () => {
    const { fetchImpl } = fakeOllama({ up: false });
    const spawnServe = vi.fn(fakeChild);
    await expect(
      ensureOllama({ baseUrl: 'http://gpu-box.lan:11434/v1', model: MODEL }, { fetch: fetchImpl, spawnServe, sleep: noSleep }),
    ).rejects.toThrow(/not local/);
    expect(spawnServe).not.toHaveBeenCalled();
  });

  it('explains a missing `ollama` binary and gives up', async () => {
    const { fetchImpl } = fakeOllama({ up: false });
    const child = fakeChild();
    const spawnServe = () => {
      queueMicrotask(() => child.emit('error', new Error('spawn ollama ENOENT')));
      return child;
    };
    await expect(
      ensureOllama({ baseUrl: BASE, model: MODEL }, { fetch: fetchImpl, spawnServe, sleep: noSleep }),
    ).rejects.toThrow(/installed and on PATH/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('refuses to pull: a missing model is an error with the pull command', async () => {
    const { fetchImpl, calls } = fakeOllama({ up: true, models: ['llama3:latest'] });
    await expect(ensureOllama({ baseUrl: BASE, model: MODEL }, { fetch: fetchImpl, sleep: noSleep })).rejects.toThrow(
      `ollama pull ${MODEL}`,
    );
    expect(calls.some((c) => c.url.endsWith('/api/pull'))).toBe(false);
  });
});

describe('helpers', () => {
  it('derives the native URL from the OpenAI-compatible one', () => {
    expect(nativeOllamaUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(nativeOllamaUrl('http://localhost:11434')).toBe('http://localhost:11434');
  });

  it('treats an untagged model as :latest', () => {
    expect(hasModel(['mistral:latest'], 'mistral')).toBe(true);
    expect(hasModel(['qwen2.5-coder:14b'], 'qwen2.5-coder:14b')).toBe(true);
    expect(hasModel(['qwen2.5-coder:7b'], 'qwen2.5-coder:14b')).toBe(false);
  });
});
