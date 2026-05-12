import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditEventStore, type AuditEventSeverity } from './audit-event.store';
import {
  DEFAULT_SEVERITY,
  type AuditAction,
  type AuditEntityType,
} from './audit-event.types';
import { CorrelationContext } from './correlation.context';

export interface EmitArgs {
  readonly action: AuditAction;
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly actor: string;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  /** Override the default severity for this action (e.g., to escalate). */
  readonly severity?: AuditEventSeverity;
  /** Override the current async-local correlation id. Rare. */
  readonly correlationId?: string;
  /** Test seam; defaults to `Date.now`. */
  readonly occurredAt?: string;
}

/**
 * Single emit() surface that every consumer uses. Pulls the correlation id
 * from {@link CorrelationContext} so callers don't have to plumb it through.
 *
 * @ref docs/01_TRD.md §18
 */
@Injectable()
export class AuditEventService {
  constructor(
    private readonly store: AuditEventStore,
    private readonly correlation: CorrelationContext,
  ) {}

  emit(args: EmitArgs): void {
    this.store.append({
      id: randomUUID(),
      entityType: args.entityType,
      entityId: args.entityId,
      actor: args.actor,
      action: args.action,
      severity: args.severity ?? DEFAULT_SEVERITY[args.action],
      before: args.before ?? null,
      after: args.after ?? null,
      correlationId: args.correlationId ?? this.correlation.current(),
      occurredAt: args.occurredAt ?? new Date().toISOString(),
    });
  }
}
