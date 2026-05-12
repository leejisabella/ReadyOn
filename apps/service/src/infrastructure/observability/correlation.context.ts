import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * AsyncLocalStorage-backed correlation context. Every entry point (GraphQL
 * operation, inbox/outbox worker tick, reconciler tick) calls `run(...)` to
 * bind a `correlationId`; downstream code reads it via `current()` instead
 * of threading it through method signatures.
 *
 * @ref docs/01_TRD.md §18, §19.3
 */
@Injectable()
export class CorrelationContext {
  private readonly als = new AsyncLocalStorage<{ correlationId: string }>();

  /**
   * Run `fn` with the given `correlationId` bound to the current async chain.
   * Any `current()` call inside `fn` (or anything it awaits) returns the same
   * id; callers outside the scope are unaffected.
   */
  run<T>(correlationId: string, fn: () => T): T {
    return this.als.run({ correlationId }, fn);
  }

  /**
   * Read the correlation id of the active scope. Falls back to a fresh UUID
   * — workers that haven't bound a scope still get a unique id per call so
   * the audit row is queryable.
   */
  current(): string {
    return this.als.getStore()?.correlationId ?? randomUUID();
  }
}
