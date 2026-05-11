/**
 * GraphQL Decimal scalar + CanonicalInputSerializer helpers.
 *
 * @ref docs/01_TRD.md §14.4, §14.5
 * @ref docs/02_Assumptions_and_Decisions.md ADR-013, ADR-014
 */
export {
  parseDecimal,
  serializeDecimal,
  formatDecimalNatural,
} from './decimal-codec';

export { DecimalScalar } from './decimal-scalar';

export {
  CanonicalInputSerializer,
  CanonicalSerializationError,
  fk,
} from './canonical-serializer';
export type { FieldKind } from './canonical-serializer';
