import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../persistence/database.token';

/**
 * Single-row advisory lock backing the provisional reconciler's mutual
 * exclusion (TRD §5.9, Rev 3.1 Q.ι). A row exists per logical reconciler
 * (currently just `'provisional'`); the row's `held_by` column being NULL
 * means free, non-NULL means held.
 *
 * `acquire` does an atomic CAS — `UPDATE ... WHERE held_by IS NULL OR
 * expires_at < :now` — so a stale lease (worker crashed without releasing)
 * is reclaimable after `expires_at` passes.
 *
 * @ref docs/01_TRD.md §5.9, §9.5.3 step [0]
 * @ref docs/02_Assumptions_and_Decisions.md ADR-026
 */
export type ReconcilerLeaseId = 'provisional';

export interface ReconcilerLeaseRow {
  readonly id: ReconcilerLeaseId;
  readonly heldBy: string | null;
  readonly acquiredAt: string | null;
  readonly expiresAt: string | null;
}

@Injectable()
export class ReconcilerLeaseStore {
  private readonly findStmt: Statement<[string]>;
  private readonly acquireStmt: Statement;
  private readonly releaseStmt: Statement;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT id, held_by AS heldBy, acquired_at AS acquiredAt, expires_at AS expiresAt
         FROM reconciler_lease
        WHERE id = ?`,
    );
    this.acquireStmt = db.prepare(
      `UPDATE reconciler_lease
          SET held_by     = :holder,
              acquired_at = :at,
              expires_at  = :expiresAt
        WHERE id = :id
          AND (held_by IS NULL OR expires_at <= :at)`,
    );
    this.releaseStmt = db.prepare(
      `UPDATE reconciler_lease
          SET held_by     = NULL,
              acquired_at = NULL,
              expires_at  = NULL
        WHERE id = :id AND held_by = :holder`,
    );
  }

  find(id: ReconcilerLeaseId): ReconcilerLeaseRow | null {
    return (this.findStmt.get(id) as ReconcilerLeaseRow | undefined) ?? null;
  }

  /**
   * Atomic compare-and-set: takes the lease only when free OR expired.
   * Returns `true` on success, `false` when another worker still holds it.
   */
  acquire(args: {
    readonly id: ReconcilerLeaseId;
    readonly holder: string;
    readonly at: string;
    readonly expiresAt: string;
  }): boolean {
    const info = this.acquireStmt.run(args);
    return info.changes === 1;
  }

  /** Releases only if the caller still holds it — never steals another worker's lease. */
  release(id: ReconcilerLeaseId, holder: string): boolean {
    const info = this.releaseStmt.run({ id, holder });
    return info.changes === 1;
  }
}
