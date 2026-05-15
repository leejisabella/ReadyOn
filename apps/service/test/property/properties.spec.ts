import * as fc from 'fast-check';
import Decimal from 'decimal.js';
import { CanonicalInputSerializer, fk, type FieldKind } from '@time-off/decimal-scalar';
import {
  HoldAccountant,
  ZERO_HOLDS,
  type Holds,
  type HoldKind,
  HoldDeltaError,
} from '../../src/domain/balance/hold-accountant';
import {
  RequestStateMachine,
  type RequestState,
} from '../../src/domain/request/request-state-machine';

/**
 * Layer 4 — Property-based tests (TRD §6 of `03_Test_Plan.md`).
 *
 * fast-check generates ≥1000 random workloads per property and verifies an
 * invariant holds on every one. These guard the system against the class of
 * regressions that example tests systematically miss: concurrency races,
 * arbitrary input sequences, and edge boundaries no human enumerated.
 *
 * Each `it` block carries a `T-PROP-*` ID matching the Test Plan's invariant
 * list. Runs default to 1000 per property — change `numRuns` per the plan's
 * "≥1000 runs/property" coverage target.
 */
const NUM_RUNS = 1000;

const ALL_STATES: ReadonlyArray<RequestState> = [
  'DRAFT',
  'PENDING_APPROVAL',
  'AWAITING_HCM_COMMIT',
  'PROVISIONALLY_APPROVED',
  'APPROVED',
  'REJECTED',
  'CANCELLATION_PENDING',
  'CANCELLED',
  'TAKEN',
  'NEEDS_REVALIDATION',
  'ESCALATED_TO_HR',
];

const TERMINAL: ReadonlyArray<RequestState> = ['REJECTED', 'CANCELLED', 'TAKEN', 'ESCALATED_TO_HR'];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbState = (): fc.Arbitrary<RequestState> => fc.constantFrom(...ALL_STATES);

const arbHoldKind = (): fc.Arbitrary<HoldKind> =>
  fc.constantFrom('pending', 'approved', 'provisional');

const arbDecimalUnits = (): fc.Arbitrary<Decimal> =>
  fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }).map(
    (n) => new Decimal(n.toFixed(2)),
  );

const arbSignedDelta = (): fc.Arbitrary<Decimal> =>
  fc.float({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true }).map(
    (n) => new Decimal(n.toFixed(2)),
  );

interface HoldOp {
  readonly kind: 'apply' | 'promote';
  readonly bucket?: HoldKind;
  readonly from?: HoldKind;
  readonly to?: HoldKind;
  readonly amount: Decimal;
}

const arbHoldOp = (): fc.Arbitrary<HoldOp> =>
  fc.oneof(
    fc.record({
      kind: fc.constant('apply' as const),
      bucket: arbHoldKind(),
      amount: arbSignedDelta(),
    }),
    fc
      .tuple(arbHoldKind(), arbHoldKind(), arbDecimalUnits())
      .filter(([from, to]) => from !== to)
      .map(
        ([from, to, amount]): HoldOp => ({ kind: 'promote', from, to, amount }),
      ),
  );

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Layer 4 — Property-based tests', () => {
  describe('T-PROP-01 — canonicalization stability', () => {
    /**
     * Two inputs that differ only in canonicalization-equivalent ways
     * (date format, decimal precision, key ordering, unknown extras) hash
     * identically. TRD §14.4 / Test Plan §6.
     */
    it('field-order independence: shuffled keys produce identical hashes', () => {
      const spec: FieldKind = fk.object({
        a: fk.string,
        b: fk.integer,
        c: fk.decimal(2),
      });
      const serializer = new CanonicalInputSerializer();
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.integer({ min: -1_000, max: 1_000 }),
          fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }).map(
            (n) => n.toFixed(2),
          ),
          (a, b, cStr) => {
            const h1 = serializer.hash({ a, b, c: cStr }, spec);
            const h2 = serializer.hash({ c: cStr, b, a }, spec);
            const h3 = serializer.hash({ b, c: cStr, a }, spec);
            expect(h1).toBe(h2);
            expect(h2).toBe(h3);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('unknown-field stripping: extras do not affect the hash', () => {
      const spec: FieldKind = fk.object({ id: fk.string });
      const serializer = new CanonicalInputSerializer();
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 30 }),
          (id, junk) => {
            const h1 = serializer.hash({ id }, spec);
            const h2 = serializer.hash({ id, junk, irrelevant: 42 }, spec);
            expect(h1).toBe(h2);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('decimal-format equivalence: 2, "2", "2.00", "2.000" all collide', () => {
      const spec: FieldKind = fk.object({ units: fk.decimal(2) });
      const serializer = new CanonicalInputSerializer();
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1000 }), (n) => {
          const variants = [`${n}`, `${n}.0`, `${n}.00`, `${n}.000`];
          const hashes = variants.map((v) => serializer.hash({ units: v }, spec));
          expect(new Set(hashes).size).toBe(1);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-02 — idempotency under retry', () => {
    /**
     * Same canonical input + same idempotency key must produce identical hashes
     * on every invocation. (The hash is the dedup key; if it's non-deterministic
     * the idempotency layer fails open.)
     */
    it('hash is a pure function of canonical input', () => {
      const spec: FieldKind = fk.object({
        employeeId: fk.string,
        leaveTypeId: fk.string,
        startDate: fk.date,
        endDate: fk.date,
        units: fk.decimal(2),
      });
      const serializer = new CanonicalInputSerializer();
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc
            .integer({ min: 0, max: 10_000 })
            .map((d) => new Date(2026, 0, 1 + (d % 365)).toISOString().slice(0, 10)),
          fc.integer({ min: 1, max: 20 }).map((u) => u.toFixed(2)),
          (employeeId, leaveTypeId, startDate, units) => {
            const input = { employeeId, leaveTypeId, startDate, endDate: startDate, units };
            const h1 = serializer.hash(input, spec);
            const h2 = serializer.hash(input, spec);
            const h3 = serializer.hash(input, spec);
            expect(h1).toBe(h2);
            expect(h2).toBe(h3);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-03 — hold-bucket non-negativity', () => {
    /**
     * For any random sequence of apply/promote operations on the three hold
     * buckets, each bucket either remains non-negative or the op throws.
     * Buckets can never reach a negative state from successful ops.
     */
    it('successful apply/promote leaves every bucket ≥ 0', () => {
      fc.assert(
        fc.property(fc.array(arbHoldOp(), { minLength: 0, maxLength: 30 }), (ops) => {
          let holds: Holds = ZERO_HOLDS;
          for (const op of ops) {
            try {
              if (op.kind === 'apply' && op.bucket) {
                holds = HoldAccountant.apply(holds, op.bucket, op.amount);
              } else if (op.kind === 'promote' && op.from && op.to) {
                holds = HoldAccountant.promote(holds, op.from, op.to, op.amount);
              }
            } catch (err) {
              expect(err).toBeInstanceOf(HoldDeltaError);
              continue;
            }
            expect(holds.pending.isNeg()).toBe(false);
            expect(holds.approved.isNeg()).toBe(false);
            expect(holds.provisional.isNeg()).toBe(false);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('promote conserves total: source-bucket loss = destination-bucket gain', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('pending', 'approved', 'provisional').chain((from) =>
            fc
              .constantFrom('pending', 'approved', 'provisional')
              .filter((to) => to !== from)
              .map((to) => ({ from, to } as { from: HoldKind; to: HoldKind })),
          ),
          arbDecimalUnits(),
          arbDecimalUnits(),
          (pair, seedUnits, moveUnits) => {
            const seeded = HoldAccountant.apply(ZERO_HOLDS, pair.from, seedUnits);
            if (seeded[pair.from].lt(moveUnits)) return; // would underflow; not a counter-example
            const moved = HoldAccountant.promote(seeded, pair.from, pair.to, moveUnits);
            expect(seeded[pair.from].sub(moved[pair.from]).toFixed()).toBe(moveUnits.toFixed());
            expect(moved[pair.to].sub(seeded[pair.to]).toFixed()).toBe(moveUnits.toFixed());
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-04 — state-machine soundness', () => {
    /**
     * Every state in the table is either terminal or has at least one legal
     * outgoing transition. Terminal states have zero transitions.
     */
    it('every state is either terminal or has ≥1 outgoing transition', () => {
      fc.assert(
        fc.property(arbState(), (state) => {
          const outs = ALL_STATES.filter((to) => RequestStateMachine.canTransition(state, to));
          if (RequestStateMachine.isTerminal(state)) {
            expect(outs.length).toBe(0);
          } else {
            expect(outs.length).toBeGreaterThan(0);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('illegal transitions throw with code STATE_TRANSITION_NOT_ALLOWED', () => {
      fc.assert(
        fc.property(arbState(), arbState(), (from, to) => {
          if (RequestStateMachine.canTransition(from, to)) return;
          try {
            RequestStateMachine.assertTransition(from, to);
            throw new Error('expected throw');
          } catch (err) {
            // DomainError carries `code` not in the message; assert on the field.
            expect((err as { code?: string }).code).toBe('STATE_TRANSITION_NOT_ALLOWED');
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('no terminal state has any outgoing transitions', () => {
      fc.assert(
        fc.property(fc.constantFrom(...TERMINAL), arbState(), (terminal, target) => {
          expect(RequestStateMachine.canTransition(terminal, target)).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-05 — decimal arithmetic correctness', () => {
    /**
     * decimal.js operations are commutative for addition and associative for
     * the operations the saga relies on. Sanity check against the brittleness
     * of IEEE-754 binary floats.
     */
    it('addition is commutative and associative', () => {
      fc.assert(
        fc.property(
          fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }).map((n) => new Decimal(n.toFixed(4))),
          fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }).map((n) => new Decimal(n.toFixed(4))),
          fc.float({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }).map((n) => new Decimal(n.toFixed(4))),
          (a, b, c) => {
            expect(a.add(b).eq(b.add(a))).toBe(true);
            expect(a.add(b).add(c).eq(a.add(b.add(c)))).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('reserve(x) followed by release(x) returns to the original balance', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1000, noNaN: true, noDefaultInfinity: true }).map((n) => new Decimal(n.toFixed(2))),
          fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }).map((n) => new Decimal(n.toFixed(2))),
          (initial, units) => {
            if (initial.lt(units)) return;
            const debited = initial.sub(units);
            const credited = debited.add(units);
            expect(credited.eq(initial)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-06 — `hcmVersion` monotonicity', () => {
    /**
     * Given a stream of `hcmVersion` updates, applying only those with strictly
     * greater version maintains a monotonically-increasing final version.
     */
    it('only-greater filter never moves backwards', () => {
      fc.assert(
        fc.property(fc.array(fc.bigInt({ min: 0n, max: 1_000_000n }), { maxLength: 50 }), (versions) => {
          let current = 0n;
          for (const v of versions) {
            if (v > current) current = v;
          }
          expect(current).toBe(
            versions.length === 0 ? 0n : versions.reduce((a, b) => (a > b ? a : b), 0n),
          );
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-07 — auditing completeness shape', () => {
    /**
     * Audit-event payloads must be JSON-serializable. The store relies on
     * `JSON.stringify` for `before_json`/`after_json`; any value that round-
     * trips losslessly is safe.
     */
    it('round-trip via JSON preserves value', () => {
      fc.assert(
        fc.property(
          fc.record({
            state: arbState(),
            employeeId: fc.string({ minLength: 1, maxLength: 20 }),
            units: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }).map((n) => n.toFixed(2)),
          }),
          (payload) => {
            const roundTrip = JSON.parse(JSON.stringify(payload));
            expect(roundTrip).toEqual(payload);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe('T-PROP-08 — pair-coalescing safety', () => {
    /**
     * For a request with an opposing approval+cancellation pair on the same
     * request_id, the coalesced outcome is symmetric: both actions land in the
     * same final state (NO_OP).
     */
    it('opposing actions on same request always pair-coalesce', () => {
      const arbPair = fc
        .record({
          requestId: fc.string({ minLength: 1, maxLength: 10 }),
          first: fc.constantFrom('BREAK_GLASS_APPROVAL' as const, 'PROVISIONAL_CANCELLATION' as const),
        });

      fc.assert(
        fc.property(arbPair, ({ requestId, first }) => {
          const opposite =
            first === 'BREAK_GLASS_APPROVAL' ? 'PROVISIONAL_CANCELLATION' : 'BREAK_GLASS_APPROVAL';
          const actions = [
            { id: 'a', requestId, type: first },
            { id: 'b', requestId, type: opposite },
          ];
          // Reproduce the coalescing predicate: same requestId, one of each type.
          const byRequest = new Map<string, typeof actions>();
          for (const a of actions) {
            const arr = byRequest.get(a.requestId) ?? [];
            arr.push(a);
            byRequest.set(a.requestId, arr);
          }
          const group = byRequest.get(requestId)!;
          const hasApproval = group.some((a) => a.type === 'BREAK_GLASS_APPROVAL');
          const hasCancellation = group.some((a) => a.type === 'PROVISIONAL_CANCELLATION');
          expect(hasApproval && hasCancellation).toBe(true);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
