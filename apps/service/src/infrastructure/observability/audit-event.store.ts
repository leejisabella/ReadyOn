import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../persistence/database.token';

/**
 * Severity vocabulary that matches the `audit_event.severity` CHECK constraint.
 * Roughly:
 *   - `INFO` — happy-path saga transitions (CREATE, APPROVED, CANCELLED).
 *   - `LOW`  — break-glass invocation (worth recording but normal during outage).
 *   - `MEDIUM` — provisional reconciliation outcomes.
 *   - `HIGH` — anything an operator should see fast (stale actions, escalations).
 */
export type AuditEventSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface AuditEventRow {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: string;
  readonly action: string;
  readonly severity: AuditEventSeverity;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  readonly occurredAt: string;
}

interface AuditEventRowRaw {
  id: string;
  entityType: string;
  entityId: string;
  actor: string;
  action: string;
  severity: AuditEventSeverity;
  before: string | null;
  after: string | null;
  correlationId: string;
  occurredAt: string;
}

const hydrate = (r: AuditEventRowRaw): AuditEventRow => ({
  id: r.id,
  entityType: r.entityType,
  entityId: r.entityId,
  actor: r.actor,
  action: r.action,
  severity: r.severity,
  before: r.before === null ? null : (JSON.parse(r.before) as Record<string, unknown>),
  after: r.after === null ? null : (JSON.parse(r.after) as Record<string, unknown>),
  correlationId: r.correlationId,
  occurredAt: r.occurredAt,
});

const SELECT_COLUMNS = `
  id,
  entity_type    AS entityType,
  entity_id      AS entityId,
  actor,
  action,
  severity,
  before_json    AS before,
  after_json     AS after,
  correlation_id AS correlationId,
  occurred_at    AS occurredAt
`;

export interface AppendAuditEventArgs {
  readonly id: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly actor: string;
  readonly action: string;
  readonly severity: AuditEventSeverity;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly correlationId: string;
  readonly occurredAt: string;
}

/**
 * Append-only repository for `audit_event` (TRD §5.7, §18). Reads are
 * indexed by `(entity_type, entity_id, occurred_at)` and by `correlation_id`
 * so the audit chain for a single request — or a single saga invocation —
 * is a fast scan.
 *
 * @ref docs/01_TRD.md §5.7, §18
 */
@Injectable()
export class AuditEventStore {
  private readonly insertStmt: Statement;
  private readonly findByEntityStmt: Statement<[string, string]>;
  private readonly findByCorrelationStmt: Statement<[string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO audit_event
              (id, entity_type, entity_id, actor, action, severity,
               before_json, after_json, correlation_id, occurred_at)
            VALUES
              (:id, :entityType, :entityId, :actor, :action, :severity,
               :before, :after, :correlationId, :occurredAt)`,
    );
    this.findByEntityStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM audit_event
        WHERE entity_type = ? AND entity_id = ?
        ORDER BY occurred_at ASC, id ASC`,
    );
    this.findByCorrelationStmt = db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM audit_event
        WHERE correlation_id = ?
        ORDER BY occurred_at ASC, id ASC`,
    );
  }

  append(args: AppendAuditEventArgs): void {
    this.insertStmt.run({
      id: args.id,
      entityType: args.entityType,
      entityId: args.entityId,
      actor: args.actor,
      action: args.action,
      severity: args.severity,
      before: args.before ? JSON.stringify(args.before) : null,
      after: args.after ? JSON.stringify(args.after) : null,
      correlationId: args.correlationId,
      occurredAt: args.occurredAt,
    });
  }

  findByEntity(entityType: string, entityId: string): AuditEventRow[] {
    return (this.findByEntityStmt.all(entityType, entityId) as AuditEventRowRaw[]).map(hydrate);
  }

  findByCorrelation(correlationId: string): AuditEventRow[] {
    return (this.findByCorrelationStmt.all(correlationId) as AuditEventRowRaw[]).map(hydrate);
  }
}
