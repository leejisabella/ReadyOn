import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  ReconciliationStepStore,
  type AppendStepArgs,
} from './reconciliation-step.store';

const stepArgs = (overrides: Partial<AppendStepArgs> = {}): AppendStepArgs => ({
  id: 'step-1',
  actionId: 'pa-1',
  kind: 'HCM_HISTORY_QUERIED',
  outcome: 'PARTIAL',
  payload: { matchCount: 0 },
  occurredAt: '2026-05-11T12:00:00.000Z',
  workerId: 'worker-1',
  ...overrides,
});

describe('ReconciliationStepStore', () => {
  let db: Database;
  let store: ReconciliationStepStore;

  beforeEach(() => {
    db = makeServiceTestDb();
    store = new ReconciliationStepStore(db);
  });

  afterEach(() => db.close());

  it('append assigns monotonic step_sequence starting at 1', () => {
    expect(store.append(stepArgs({ id: 's-1' }))).toBe(1);
    expect(store.append(stepArgs({ id: 's-2', kind: 'HCM_CALL_IN_FLIGHT' }))).toBe(2);
    expect(store.append(stepArgs({ id: 's-3', kind: 'OUTCOME_APPLIED', outcome: 'TERMINAL' }))).toBe(3);
  });

  it('step_sequence is per-action_id (independent counters)', () => {
    store.append(stepArgs({ id: 's-1', actionId: 'pa-1' }));
    store.append(stepArgs({ id: 's-2', actionId: 'pa-1' }));
    expect(store.append(stepArgs({ id: 's-3', actionId: 'pa-2' }))).toBe(1);
  });

  it('findLast returns the most-recent step for an action', () => {
    store.append(stepArgs({ id: 's-1' }));
    store.append(stepArgs({ id: 's-2', kind: 'HCM_CALL_IN_FLIGHT', payload: { args: 'reserve' } }));
    const last = store.findLast('pa-1');
    expect(last?.kind).toBe('HCM_CALL_IN_FLIGHT');
    expect(last?.stepSequence).toBe(2);
    expect(last?.payload).toEqual({ args: 'reserve' });
  });

  it('findLast returns null when no steps exist', () => {
    expect(store.findLast('pa-unknown')).toBeNull();
  });

  it('listForAction returns rows in ascending step_sequence', () => {
    store.append(stepArgs({ id: 's-3', kind: 'OUTCOME_APPLIED', outcome: 'TERMINAL' }));
    store.append(stepArgs({ id: 's-4', kind: 'HCM_CALL_IN_FLIGHT' }));
    const rows = store.listForAction('pa-1');
    expect(rows.map((r) => r.id)).toEqual(['s-3', 's-4']);
    expect(rows.map((r) => r.stepSequence)).toEqual([1, 2]);
  });

  it('hydrates JSON payload back to an object', () => {
    store.append(stepArgs({ payload: { hcmTransactionId: 'tx-7', delta: '-3' } }));
    expect(store.findLast('pa-1')?.payload).toEqual({
      hcmTransactionId: 'tx-7',
      delta: '-3',
    });
  });
});
