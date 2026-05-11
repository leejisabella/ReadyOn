import Decimal from 'decimal.js';

/**
 * Pure arithmetic over the three hold buckets (TRD §4.1, §5.1).
 *
 * No I/O, no state — every method takes the current `Holds` and returns a
 * new one. The accountant enforces two invariants:
 *
 *  1. No bucket may go negative after a delta is applied.
 *  2. Promotion between buckets is atomic: both legs (source debit, dest
 *     credit) succeed together or the call throws.
 *
 * The "available ≥ total holds" invariant is the BalanceState concern —
 * detected via {@link HoldAccountant.isDeficit} and surfaced as
 * `UNDER_HOLD_DEFICIT` by the BalanceService (TRD §6.1).
 *
 * @ref docs/01_TRD.md §4.1, §5.1, §6.1
 * @ref docs/04_Module_Plan.md §3.3
 */

export type HoldKind = 'pending' | 'approved' | 'provisional';

export interface Holds {
  readonly pending: Decimal;
  readonly approved: Decimal;
  readonly provisional: Decimal;
}

export const ZERO_HOLDS: Holds = Object.freeze({
  pending: new Decimal(0),
  approved: new Decimal(0),
  provisional: new Decimal(0),
});

/** Thrown when a hold operation would violate a bucket invariant. */
export class HoldDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldDeltaError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HoldAccountant {
  /**
   * Add `delta` to the named bucket. Throws if the result would be negative —
   * the caller is responsible for either preventing the delta or catching.
   */
  static apply(holds: Holds, kind: HoldKind, delta: Decimal): Holds {
    const updated = holds[kind].add(delta);
    if (updated.isNeg()) {
      throw new HoldDeltaError(
        `bucket '${kind}' cannot go negative (current=${holds[kind].toFixed()}, delta=${delta.toFixed()})`,
      );
    }
    return { ...holds, [kind]: updated };
  }

  /**
   * Move `units` (non-negative) from one bucket to another atomically. Throws
   * if `from === to`, if `units` is negative, or if the source bucket lacks
   * the units (atomic — no partial state survives the throw).
   */
  static promote(holds: Holds, from: HoldKind, to: HoldKind, units: Decimal): Holds {
    if (from === to) {
      throw new HoldDeltaError(`promote: source and destination must differ ('${from}')`);
    }
    if (units.isNeg()) {
      throw new HoldDeltaError(`promote: units must be non-negative (got ${units.toFixed()})`);
    }
    return this.apply(this.apply(holds, from, units.neg()), to, units);
  }

  /** Sum of all three buckets. */
  static total(holds: Holds): Decimal {
    return holds.pending.add(holds.approved).add(holds.provisional);
  }

  /**
   * `true` when `available < total(holds)` — the inbound HCM update brought
   * `available` below what we've committed locally. The BalanceService maps
   * this to `BalanceState = UNDER_HOLD_DEFICIT` (TRD §6.1).
   */
  static isDeficit(available: Decimal, holds: Holds): boolean {
    return available.lt(this.total(holds));
  }
}
