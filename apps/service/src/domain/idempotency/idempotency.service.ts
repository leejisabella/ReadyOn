import { Injectable } from '@nestjs/common';
import { IdempotencyStore } from './idempotency.store';

/** Outcome of looking up an idempotency key against the cache. */
export type IdempotencyResolution<T> =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'replay'; readonly response: T }
  | { readonly kind: 'conflict' };

/** TRD §16: `idempotency.keyTtlMs` default 7 days. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Inbound idempotency cache. Saga mutations call {@link resolve} at entry —
 * a `replay` short-circuits to the cached response, a `conflict` raises
 * `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT`, and `fresh` proceeds with
 * the operation and stamps the result via {@link remember}.
 *
 * @ref docs/01_TRD.md §14.1, §14.2
 * @ref docs/04_Module_Plan.md §3.8
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly store: IdempotencyStore) {}

  resolve<T>(key: string, inputHash: string): IdempotencyResolution<T> {
    const existing = this.store.find(key);
    if (existing === null) return { kind: 'fresh' };
    if (existing.inputHash !== inputHash) return { kind: 'conflict' };
    return { kind: 'replay', response: existing.responseSnapshot as T };
  }

  remember(
    key: string,
    inputHash: string,
    response: unknown,
    ttlMs: number = DEFAULT_TTL_MS,
  ): void {
    const now = Date.now();
    this.store.insert({
      key,
      inputHash,
      responseSnapshot: response,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    });
  }
}
