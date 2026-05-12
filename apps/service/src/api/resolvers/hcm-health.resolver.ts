import { Query, Resolver } from '@nestjs/graphql';
import {
  BreakGlassAuthorizer,
} from '../../domain/break-glass/break-glass.authorizer';
import { HcmHealthMonitor } from '../../infrastructure/hcm/hcm-health.monitor';
import { CurrentActor } from '../auth/current-actor.decorator';
import type { ActorContext } from '../../domain/request/request.service';
import { HcmHealthStatusType } from '../types/hcm-health-status.type';

@Resolver(() => HcmHealthStatusType)
export class HcmHealthResolver {
  constructor(
    private readonly health: HcmHealthMonitor,
    private readonly breakGlass: BreakGlassAuthorizer,
  ) {}

  @Query(() => HcmHealthStatusType, {
    description:
      'HCM reachability snapshot. `breakGlassAvailable` is true iff outage duration ' +
      "meets `minOutageMs` AND the caller's role is `break_glass_approver`.",
  })
  hcmHealth(@CurrentActor() actor: ActorContext): HcmHealthStatusType {
    const reachable = this.health.isHealthy();
    const auth = this.breakGlass.authorize({ actorRole: actor.actorRole });
    return {
      reachable,
      outageStartedAt: this.health.outageStartedAt()?.toISOString() ?? null,
      breakGlassAvailable: auth.kind === 'OK',
    };
  }
}
