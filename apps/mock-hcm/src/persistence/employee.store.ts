import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from './database.token';

export interface EmployeeRow {
  readonly employeeId: string;
  readonly hcmVersion: bigint;
  readonly createdAt: string;
}

@Injectable()
export class EmployeeStore {
  private readonly findStmt: Statement<[string]>;
  private readonly insertStmt: Statement<[string, string, string]>;
  private readonly deleteStmt: Statement<[string]>;
  private readonly listStmt: Statement<[]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT employee_id AS employeeId, hcm_version AS hcmVersion, created_at AS createdAt
         FROM employees
        WHERE employee_id = ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO employees (employee_id, hcm_version, created_at) VALUES (?, ?, ?)`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM employees WHERE employee_id = ?`);
    this.listStmt = db.prepare(
      `SELECT employee_id AS employeeId, hcm_version AS hcmVersion, created_at AS createdAt
         FROM employees
         ORDER BY employee_id`,
    );
  }

  find(employeeId: string): EmployeeRow | null {
    const row = this.findStmt.get(employeeId) as
      | { employeeId: string; hcmVersion: string; createdAt: string }
      | undefined;
    return row ? { ...row, hcmVersion: BigInt(row.hcmVersion) } : null;
  }

  insert(row: EmployeeRow): void {
    this.insertStmt.run(row.employeeId, row.hcmVersion.toString(), row.createdAt);
  }

  /** Returns the number of rows removed (0 if the employee was not found). */
  delete(employeeId: string): number {
    return this.deleteStmt.run(employeeId).changes;
  }

  list(): EmployeeRow[] {
    const rows = this.listStmt.all() as ReadonlyArray<{
      employeeId: string;
      hcmVersion: string;
      createdAt: string;
    }>;
    return rows.map((r) => ({ ...r, hcmVersion: BigInt(r.hcmVersion) }));
  }
}
