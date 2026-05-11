import type { Database } from 'better-sqlite3';

/**
 * Belt-and-suspenders enforcement of the append-only conventions for
 * `provisional_action` and `reconciliation_step`. Disabled by default; enable
 * via `DatabaseModule.forRoot({ appendOnlyTriggers: true })` for
 * compliance-heavy deployments. The repository layer is the primary
 * enforcement; these triggers catch direct SQL writes that bypass it.
 *
 * @ref docs/01_TRD.md §5.8.1
 * @ref docs/02_Assumptions_and_Decisions.md ADR-019, ADR-022
 */

/**
 * Fields on `provisional_action` that `markReconciled` is permitted to update.
 * Five mandated by ADR-022 (Rev 3.1, Q.θ); `last_stale_alert_at` added for
 * the stale-alert dedup in TRD §9.5.6. Any update touching a column outside
 * this list is aborted by the trigger.
 */
const PROVISIONAL_ACTION_ALLOWLIST = [
  'reconciliation_state',
  'reconciled_at',
  'reconciliation_details',
  'local_state_snapshot',
  'local_state_snapshot_summary',
  'last_stale_alert_at',
] as const;

const PROVISIONAL_ACTION_IMMUTABLE = [
  'id',
  'type',
  'request_id',
  'invoked_by',
  'invoked_at',
  'reason',
  'outage_start_observed_at',
] as const;

/**
 * Apply the trigger set. Idempotent — uses `CREATE TRIGGER IF NOT EXISTS` so
 * repeated calls (or migrate-then-restart cycles) are safe.
 */
export function applyAppendOnlyTriggers(db: Database): void {
  // SQLite lacks `IS NOT DISTINCT FROM`; emulate with NULL-aware equality.
  const unchanged = (col: string): string =>
    `((NEW.${col} IS NULL AND OLD.${col} IS NULL) OR NEW.${col} = OLD.${col})`;

  const immutableGuard = PROVISIONAL_ACTION_IMMUTABLE.map(unchanged).join(' AND ');

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS provisional_action_immutable_fields
    BEFORE UPDATE ON provisional_action
    FOR EACH ROW
    WHEN NOT (${immutableGuard})
    BEGIN
      SELECT RAISE(ABORT, 'provisional_action: attempted to modify an immutable field (allow-list: ${PROVISIONAL_ACTION_ALLOWLIST.join(
        ', ',
      )})');
    END;

    CREATE TRIGGER IF NOT EXISTS provisional_action_no_delete
    BEFORE DELETE ON provisional_action
    BEGIN
      SELECT RAISE(ABORT, 'provisional_action: delete prohibited');
    END;

    CREATE TRIGGER IF NOT EXISTS reconciliation_step_no_update
    BEFORE UPDATE ON reconciliation_step
    BEGIN
      SELECT RAISE(ABORT, 'reconciliation_step: updates prohibited');
    END;

    CREATE TRIGGER IF NOT EXISTS reconciliation_step_no_delete
    BEFORE DELETE ON reconciliation_step
    BEGIN
      SELECT RAISE(ABORT, 'reconciliation_step: delete prohibited');
    END;
  `);
}

/** The Rev 3.1 mutation allow-list for `provisional_action`. Exposed for repository validation. */
export const PROVISIONAL_ACTION_ALLOWED_UPDATE_COLUMNS = PROVISIONAL_ACTION_ALLOWLIST;
