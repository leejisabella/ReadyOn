import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import { GraphQLError } from 'graphql';
import { randomUUID } from 'node:crypto';
import type { ActorRole } from '../../domain/break-glass/break-glass.authorizer';
import type { ActorContext } from '../../domain/request/request.service';

const VALID_ROLES: ReadonlyArray<ActorRole> = [
  'employee',
  'manager',
  'break_glass_approver',
  'hr_admin',
];

/**
 * Resolves the {@link ActorContext} for a GraphQL operation from gateway-set
 * headers — `x-actor-id`, `x-actor-role`, and an optional `x-correlation-id`
 * (generated when absent so every request has one for log correlation).
 *
 * The gateway is responsible for terminating SSO and signing these headers
 * (TRD §15). The service trusts them as the auth boundary.
 *
 * @ref docs/01_TRD.md §15
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ActorContext => {
    const gqlCtx = GqlExecutionContext.create(context);
    const req = gqlCtx.getContext<{ req: Request }>().req;

    const actorId = headerValue(req, 'x-actor-id');
    const actorRoleRaw = headerValue(req, 'x-actor-role');
    if (actorId === null) {
      throw new GraphQLError('missing x-actor-id header', {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }
    if (actorRoleRaw === null) {
      throw new GraphQLError('missing x-actor-role header', {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }
    if (!(VALID_ROLES as readonly string[]).includes(actorRoleRaw)) {
      throw new GraphQLError(`unknown x-actor-role: ${actorRoleRaw}`, {
        extensions: { code: 'UNAUTHENTICATED' },
      });
    }

    return {
      actorId,
      actorRole: actorRoleRaw as ActorRole,
      correlationId: headerValue(req, 'x-correlation-id') ?? randomUUID(),
    };
  },
);

function headerValue(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return null;
}
