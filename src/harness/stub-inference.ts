import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenAI-compatible endpoint that answers each protocol phase from a
 * script. Lets the whole service run end to end with no inference provider.
 */
export type PhaseName =
  | 'brief'
  | 'lane'
  | 'sparring'
  | 'shredder'
  | 'verdict'
  | 'followup_verify'
  | 'followup_challenge'
  | 'followup_resolve'
  | 'unknown';

export interface StubRequest {
  phase: PhaseName;
  persona: string;
  system: string;
  user: string;
}

/** Answers may be a fixed string or a function of the request. */
export type Responder = string | ((request: StubRequest) => string);

export type Script = Partial<Record<PhaseName, Responder>> & {
  /** Per-persona overrides for lane responses, keyed by persona name. */
  lanes?: Record<string, Responder>;
};

/**
 * The protocol text names every phase, so only the instruction appended after
 * the role block identifies which phase a prompt belongs to.
 */
export function detectPhase(system: string): PhaseName {
  const instruction = system.split('</your_role>').at(-1) ?? '';
  if (instruction.includes('Phase 1')) return 'brief';
  if (instruction.includes('Phase 2')) return 'lane';
  if (instruction.includes('Phase 4')) return 'sparring';
  if (instruction.includes('Phase 5')) return 'shredder';
  if (instruction.includes('Phase 6')) return 'verdict';
  if (instruction.includes('Follow-up verification')) return 'followup_verify';
  if (instruction.includes('Follow-up challenge')) return 'followup_challenge';
  if (instruction.includes('Follow-up adjudication')) return 'followup_resolve';
  return 'unknown';
}

export function detectPersona(system: string): string {
  return /^You are (.+?) of The Dojo/.exec(system)?.[1] ?? 'unknown';
}

export interface StubInference {
  url: string;
  /** Every prompt the service sent, in order. */
  requests: StubRequest[];
  close(): Promise<void>;
}

export async function startStubInference(script: Script): Promise<StubInference> {
  const requests: StubRequest[] = [];

  const server = createServer((request, response) => {
    if (!request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
      const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
      const phase = detectPhase(system);
      const persona = detectPersona(system);
      const record: StubRequest = { phase, persona, system, user };
      requests.push(record);

      const responder =
        (phase === 'lane' ? script.lanes?.[persona] : undefined) ?? script[phase] ?? '{}';
      const content = typeof responder === 'function' ? responder(record) : responder;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => closeServer(server),
  };
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
