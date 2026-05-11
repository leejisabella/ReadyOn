import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 signature, hex-encoded. Used by both signers (test fixtures,
 * production HCMs) and the verifier.
 */
export function computeSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Constant-time signature verification (TRD §10.1 — `crypto.timingSafeEqual`).
 * Returns `false` for any mismatch, including length differences.
 */
export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = computeSignature(body, secret);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
}
