import Decimal from 'decimal.js';
import {
  HoldAccountant,
  HoldDeltaError,
  ZERO_HOLDS,
  type Holds,
} from './hold-accountant';

const holds = (overrides: Partial<Holds> = {}): Holds => ({
  pending: new Decimal(0),
  approved: new Decimal(0),
  provisional: new Decimal(0),
  ...overrides,
});

describe('HoldAccountant', () => {
  describe('apply', () => {
    it.each(['pending', 'approved', 'provisional'] as const)('adds delta to the %s bucket', (kind) => {
      const result = HoldAccountant.apply(ZERO_HOLDS, kind, new Decimal(3));
      expect(result[kind].toFixed()).toBe('3');
    });

    it('subtracts when delta is negative', () => {
      const result = HoldAccountant.apply(
        holds({ pending: new Decimal(5) }),
        'pending',
        new Decimal(-2),
      );
      expect(result.pending.toFixed()).toBe('3');
    });

    it('rejects a delta that would push the bucket negative', () => {
      try {
        HoldAccountant.apply(holds({ approved: new Decimal(2) }), 'approved', new Decimal(-3));
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HoldDeltaError);
        expect((err as Error).name).toBe('HoldDeltaError');
        expect((err as Error).message).toMatch(/bucket 'approved' cannot go negative.*current=2.*delta=-3/);
      }
    });

    it('does not mutate the input', () => {
      const before = ZERO_HOLDS;
      HoldAccountant.apply(before, 'pending', new Decimal(1));
      expect(before.pending.toFixed()).toBe('0');
    });
  });

  describe('promote', () => {
    it('moves units between buckets atomically', () => {
      const result = HoldAccountant.promote(
        holds({ pending: new Decimal(5) }),
        'pending',
        'approved',
        new Decimal(2),
      );
      expect(result.pending.toFixed()).toBe('3');
      expect(result.approved.toFixed()).toBe('2');
    });

    it('rejects when source and destination are the same bucket (even if the bucket has enough units)', () => {
      // pending=10 so the *alternative* path (subtract then add) would succeed
      // if the guard were ever skipped; the rejection must be the guard itself.
      expect(() =>
        HoldAccountant.promote(holds({ pending: new Decimal(10) }), 'pending', 'pending', new Decimal(1)),
      ).toThrow(/promote: source and destination must differ \('pending'\)/);
    });

    it('rejects negative units (even if both buckets have enough to absorb the swap)', () => {
      // both buckets prefunded so the *alternative* path (apply +units to source,
      // -units to dest) would not trip the non-negative invariant; the guard
      // must be the only thing rejecting.
      expect(() =>
        HoldAccountant.promote(
          holds({ pending: new Decimal(5), approved: new Decimal(5) }),
          'pending',
          'approved',
          new Decimal(-1),
        ),
      ).toThrow(/promote: units must be non-negative \(got -1\)/);
    });

    it('throws atomically when the source bucket lacks enough units (no partial write)', () => {
      const before = holds({ pending: new Decimal(1), approved: new Decimal(0) });
      expect(() =>
        HoldAccountant.promote(before, 'pending', 'approved', new Decimal(2)),
      ).toThrow(HoldDeltaError);
      // unchanged
      expect(before.pending.toFixed()).toBe('1');
      expect(before.approved.toFixed()).toBe('0');
    });
  });

  describe('total + isDeficit', () => {
    it('sums all three buckets', () => {
      const sum = HoldAccountant.total(
        holds({ pending: new Decimal(1), approved: new Decimal(2), provisional: new Decimal(4) }),
      );
      expect(sum.toFixed()).toBe('7');
    });

    it('isDeficit is true when available < total holds', () => {
      expect(
        HoldAccountant.isDeficit(new Decimal(5), holds({ pending: new Decimal(6) })),
      ).toBe(true);
    });

    it('isDeficit is false when available equals total holds (edge of the boundary)', () => {
      expect(
        HoldAccountant.isDeficit(new Decimal(6), holds({ pending: new Decimal(6) })),
      ).toBe(false);
    });

    it('isDeficit is false when available exceeds total holds', () => {
      expect(
        HoldAccountant.isDeficit(new Decimal(10), holds({ pending: new Decimal(3) })),
      ).toBe(false);
    });
  });
});
