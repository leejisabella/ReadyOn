import { Field, ObjectType } from '@nestjs/graphql';
import { DateTime } from "../scalars/date-time.scalar";

@ObjectType('HcmHealthStatus', { description: 'Snapshot of HCM reachability and break-glass eligibility.' })
export class HcmHealthStatusType {
  @Field(() => Boolean) readonly reachable!: boolean;
  @Field(() => DateTime, { nullable: true }) readonly outageStartedAt!: string | null;
  /** `true` iff outage duration exceeds `breakGlassMinOutageMs` AND caller has the role. */
  @Field(() => Boolean) readonly breakGlassAvailable!: boolean;
}
