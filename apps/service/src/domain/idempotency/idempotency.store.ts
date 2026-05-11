import { Inject, Injectable } from '@nestjs/common';
import type { Database, Statement } from 'better-sqlite3';
import { DATABASE } from '../../infrastructure/persistence/database.token';

export interface IdempotencyRow {
  readonly key: string;
  readonly inputHash: string;
  readonly responseSnapshot: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface IdempotencyRowRaw {
  key: string;
  inputHash: string;
  responseSnapshotJson: string;
  createdAt: string;
  expiresAt: string;
}

const hydrate = (r: IdempotencyRowRaw): IdempotencyRow => ({
  key: r.key,
  inputHash: r.inputHash,
  responseSnapshot: JSON.parse(r.responseSnapshotJson) as unknown,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
});

@Injectable()
export class IdempotencyStore {
  private readonly findStmt: Statement<[string]>;
  private readonly insertStmt: Statement<[string, string, string, string, string]>;

  constructor(@Inject(DATABASE) db: Database) {
    this.findStmt = db.prepare(
      `SELECT key, input_hash AS inputHash, response_snapshot AS responseSnapshotJson,
              created_at AS createdAt, expires_at AS expiresAt
         FROM idempotency_key
        WHERE key = ?`,
    );
    this.insertStmt = db.prepare(
      `INSERT INTO idempotency_key (key, input_hash, response_snapshot, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
    );
  }

  find(key: string): IdempotencyRow | null {
    const row = this.findStmt.get(key) as IdempotencyRowRaw | undefined;
    return row ? hydrate(row) : null;
  }

  insert(row: IdempotencyRow): void {
    this.insertStmt.run(
      row.key,
      row.inputHash,
      JSON.stringify(row.responseSnapshot),
      row.createdAt,
      row.expiresAt,
    );
  }
}
