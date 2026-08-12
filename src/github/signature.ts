import { createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time verification of the `x-hub-signature-256` webhook header. */
export function verifySignature(secret: string, payload: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const received = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}
