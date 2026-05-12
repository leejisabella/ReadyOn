import type { AuditEventSeverity } from './audit-event.store';

/**
 * Closed catalogue of every audit action this service emits. Adding an event
 * means extending this union — callers cannot pass a free-form string.
 *
 * Names match TRD §9 / §11 / §18 verbatim so an audit query against the table
 * is greppable from the spec.
 */
export type AuditAction =
  // Saga lifecycle (TRD §9.1–§9.4)
  | 'REQUEST_CREATED'
  | 'REQUEST_APPROVED'
  | 'REQUEST_REJECTED'
  | 'REQUEST_CANCELLED'
  // Break-glass (TRD §9.5.1–§9.5.2)
  | 'BREAK_GLASS_APPROVAL_INVOKED'
  // Provisional cancellation (TRD §9.5.4)
  | 'PROVISIONAL_CANCELLATION_INVOKED'
  // Provisional reconciler outcomes (TRD §9.5.3)
  | 'PROVISIONAL_APPROVAL_CONFIRMED'
  | 'PROVISIONAL_APPROVAL_ESCALATED'
  | 'PROVISIONAL_CANCELLATION_CONFIRMED'
  | 'PROVISIONAL_PAIR_COALESCED'
  | 'PROVISIONAL_RECONCILIATION_PASS_COMPLETED'
  | 'PROVISIONAL_ACTION_STALE'
  // Employee bootstrap (TRD §11.2, §11.3)
  | 'EMPLOYEE_BOOTSTRAPPED'
  // HR review marker (TRD §14.6, §9.5.5)
  | 'HR_REVIEW_REQUIRED';

export const DEFAULT_SEVERITY: Readonly<Record<AuditAction, AuditEventSeverity>> = Object.freeze({
  REQUEST_CREATED: 'INFO',
  REQUEST_APPROVED: 'INFO',
  REQUEST_REJECTED: 'INFO',
  REQUEST_CANCELLED: 'INFO',
  BREAK_GLASS_APPROVAL_INVOKED: 'LOW',
  PROVISIONAL_CANCELLATION_INVOKED: 'LOW',
  PROVISIONAL_APPROVAL_CONFIRMED: 'MEDIUM',
  PROVISIONAL_APPROVAL_ESCALATED: 'HIGH',
  PROVISIONAL_CANCELLATION_CONFIRMED: 'MEDIUM',
  PROVISIONAL_PAIR_COALESCED: 'MEDIUM',
  PROVISIONAL_RECONCILIATION_PASS_COMPLETED: 'INFO',
  PROVISIONAL_ACTION_STALE: 'HIGH',
  EMPLOYEE_BOOTSTRAPPED: 'INFO',
  HR_REVIEW_REQUIRED: 'HIGH',
});

/**
 * Entity types that audit rows can be keyed by. The string is stored as-is in
 * `audit_event.entity_type` — the literal union exists so a typo would fail
 * to compile.
 */
export type AuditEntityType =
  | 'TimeOffRequest'
  | 'ProvisionalAction'
  | 'Employee'
  | 'Reconciler';
