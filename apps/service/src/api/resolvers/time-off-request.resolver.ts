import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DomainError } from '@time-off/domain-types';
import { RequestService, type ActorContext } from '../../domain/request/request.service';
import { RequestStore } from '../../domain/request/request.store';
import { CurrentActor } from '../auth/current-actor.decorator';
import { RequestState } from '../enums';
import { CreateTimeOffRequestInputType } from '../inputs/create-time-off-request.input';
import {
  TimeOffRequestPayload,
  TimeOffRequestType,
} from '../types/time-off-request.type';

/**
 * Top-level resolver for TRD §9.1–§9.5 mutations and the
 * `timeOffRequest{,s}` reads. Every mutation routes through `RequestService`,
 * which owns idempotency, state-machine assertions, and HCM orchestration.
 * The actor identity is sourced from gateway-signed headers via
 * {@link CurrentActor} (TRD §15) — `actorId` / `approverId` arguments named
 * by the schema are validated against the asserted identity.
 *
 * @ref docs/01_TRD.md §7.1, §9.1–§9.5
 */
@Resolver(() => TimeOffRequestType)
export class TimeOffRequestResolver {
  constructor(
    private readonly requests: RequestService,
    private readonly store: RequestStore,
  ) {}

  // ── Queries ──────────────────────────────────────────────────────────────

  @Query(() => TimeOffRequestType, {
    nullable: true,
    description: 'Fetch a single time-off request by id.',
  })
  timeOffRequest(@Args('id', { type: () => ID }) id: string): TimeOffRequestType | null {
    return this.store.find(id) as TimeOffRequestType | null;
  }

  @Query(() => [TimeOffRequestType], {
    description: 'List requests for an employee, optionally filtered by state.',
  })
  timeOffRequests(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('states', { type: () => [RequestState], nullable: true })
    states: ReadonlyArray<RequestState> | null,
  ): TimeOffRequestType[] {
    return this.store.listForEmployee(employeeId, states ?? null) as TimeOffRequestType[];
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  @Mutation(() => TimeOffRequestPayload, { description: 'TRD §9.1' })
  async createTimeOffRequest(
    @Args('input') input: CreateTimeOffRequestInputType,
    @Args('idempotencyKey', { type: () => ID }) idempotencyKey: string,
    @CurrentActor() actor: ActorContext,
  ): Promise<TimeOffRequestPayload> {
    assertActorMatches(actor.actorId, input.employeeId, 'employeeId');
    const request = await this.requests.create(input, actor, idempotencyKey);
    return { request: request as TimeOffRequestType };
  }

  @Mutation(() => TimeOffRequestPayload, { description: 'TRD §9.2' })
  async approveTimeOffRequest(
    @Args('id', { type: () => ID }) id: string,
    @Args('approverId', { type: () => ID }) approverId: string,
    @Args('idempotencyKey', { type: () => ID }) idempotencyKey: string,
    @CurrentActor() actor: ActorContext,
  ): Promise<TimeOffRequestPayload> {
    assertActorMatches(actor.actorId, approverId, 'approverId');
    const request = await this.requests.approve(id, actor, idempotencyKey);
    return { request: request as TimeOffRequestType };
  }

  @Mutation(() => TimeOffRequestPayload, { description: 'TRD §9.5.2 (break-glass)' })
  async approveTimeOffRequestProvisionally(
    @Args('id', { type: () => ID }) id: string,
    @Args('approverId', { type: () => ID }) approverId: string,
    @Args('justification') justification: string,
    @Args('idempotencyKey', { type: () => ID }) idempotencyKey: string,
    @CurrentActor() actor: ActorContext,
  ): Promise<TimeOffRequestPayload> {
    assertActorMatches(actor.actorId, approverId, 'approverId');
    const request = await this.requests.approveProvisionally(
      id,
      justification,
      actor,
      idempotencyKey,
    );
    return { request: request as TimeOffRequestType };
  }

  @Mutation(() => TimeOffRequestPayload, { description: 'TRD §9.3' })
  async rejectTimeOffRequest(
    @Args('id', { type: () => ID }) id: string,
    @Args('approverId', { type: () => ID }) approverId: string,
    @Args('reason') reason: string,
    @Args('idempotencyKey', { type: () => ID }) idempotencyKey: string,
    @CurrentActor() actor: ActorContext,
  ): Promise<TimeOffRequestPayload> {
    assertActorMatches(actor.actorId, approverId, 'approverId');
    const request = await this.requests.reject(id, reason, actor, idempotencyKey);
    return { request: request as TimeOffRequestType };
  }

  @Mutation(() => TimeOffRequestPayload, {
    description: 'TRD §9.4 / §9.5.4. Pass `acknowledgedHcmUnavailable: true` to route through the provisional path.',
  })
  async cancelTimeOffRequest(
    @Args('id', { type: () => ID }) id: string,
    @Args('actorId', { type: () => ID }) actorId: string,
    @Args('idempotencyKey', { type: () => ID }) idempotencyKey: string,
    @Args('acknowledgedHcmUnavailable', { type: () => Boolean, defaultValue: false })
    acknowledgedHcmUnavailable: boolean,
    @CurrentActor() actor: ActorContext,
  ): Promise<TimeOffRequestPayload> {
    assertActorMatches(actor.actorId, actorId, 'actorId');
    const request = acknowledgedHcmUnavailable
      ? await this.requests.cancelProvisionally(id, actor, idempotencyKey, {
          acknowledgedHcmUnavailable: true,
        })
      : await this.requests.cancel(id, actor, idempotencyKey);
    return { request: request as TimeOffRequestType };
  }
}

/**
 * Defense-in-depth: the schema lets callers pass the actor as an argument
 * (`approverId` / `actorId` / `employeeId`) for ergonomics, but the
 * authoritative identity is the gateway-signed header. If the two disagree
 * we refuse — the alternative (silently trusting the arg) would let a
 * compromised client impersonate any user the gateway authenticated.
 */
function assertActorMatches(headerActorId: string, argActorId: string, argName: string): void {
  if (headerActorId !== argActorId) {
    throw new DomainError({
      code: 'STATE_TRANSITION_NOT_ALLOWED',
      message: `gateway-asserted actor (${headerActorId}) does not match ${argName} (${argActorId})`,
      details: { headerActorId, argName, argActorId },
    });
  }
}

