import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from './database.token';

/**
 * Monotonic `hcmVersion` counter. Real HCM systems have a global change log;
 * we mirror that as a single row in `meta`. Every successful mutation calls
 * `next()` to obtain a strictly-greater version.
 *
 * @ref docs/01_TRD.md §10.1 (hcmVersion is the only ordering authority).
 */
@Injectable()
export class VersionStore {
  private readonly incrementStmt: Statement<[]>;
  private readonly readStmt: Statement<[]>;
  private readonly setStmt: Statement<[string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.incrementStmt = db.prepare(
      `UPDATE meta
          SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'current_hcm_version'
       RETURNING value`,
    );
    this.readStmt = db.prepare(`SELECT value FROM meta WHERE key = 'current_hcm_version'`);
    this.setStmt = db.prepare(`UPDATE meta SET value = ? WHERE key = 'current_hcm_version'`);
  }

  /** Atomically advance and return the new version. */
  next(): bigint {
    const row = this.incrementStmt.get() as { value: string } | undefined;
    if (!row) throw new Error('meta.current_hcm_version row is missing');
    return BigInt(row.value);
  }

  /** Read-only peek at the current version. */
  current(): bigint {
    const row = this.readStmt.get() as { value: string } | undefined;
    if (!row) throw new Error('meta.current_hcm_version row is missing');
    return BigInt(row.value);
  }

  /**
   * Force-set the counter to a specific value. Used only by snapshot restore
   * (admin `/restoreState`) so the post-restore state matches precisely —
   * including the next version that will be issued.
   */
  setTo(value: bigint): void {
    this.setStmt.run(value.toString());
  }
}
