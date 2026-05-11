import type {
  FetchBalanceArgs,
  HcmBatchEntry,
  HcmEmployeeResponse,
  HcmEmploymentResponse,
  HcmFetchBalanceResponse,
  HcmLeaveTypesResponse,
  HcmMutationResponse,
  HcmTransactionQuery,
  HcmTransactionRecord,
  ReleaseBalanceArgs,
  ReserveBalanceArgs,
} from './schemas';

/**
 * Contract that every HCM adapter MUST satisfy.
 *
 * The interface is intentionally small: eight methods, each with a single
 * documented purpose. Adapters validate every wire response against the zod
 * schema in `schemas.ts` and throw a typed {@link HcmError} subclass on
 * failure; happy-path returns are post-validation, fully-typed values
 * (`Decimal`, `bigint`, not strings).
 *
 * Two ADRs constrain this interface:
 *
 *  - **ADR-005** — every mutation response carries `transactionId`,
 *    `deltaApplied`, `newAvailable`, `hcmVersion`, `appliedAt`.
 *  - **ADR-018** — `queryTransactions` is required so the provisional
 *    reconciler can verify exactly-once execution across our crashes.
 *
 * @ref docs/01_TRD.md §13.2, §13.2.1
 * @ref docs/04_Module_Plan.md §5.1
 */
export interface HcmPort {
  /**
   * Read a single balance. Used by the saga at request creation (advisory
   * pre-check) and by the deferred point-read scheduler (defense in depth).
   *
   * @throws HcmTransientError when HCM is unreachable or returns 5xx.
   * @throws HcmEmployeeNotFoundError when HCM has no record of the employee.
   * @throws HcmPermanentError for other permanent failures.
   * @throws HcmContractViolation when the response fails schema validation.
   */
  fetchBalance(args: FetchBalanceArgs): Promise<HcmFetchBalanceResponse>;

  /**
   * Debit `units` from the balance and return the confirmed transaction.
   * Idempotent on `idempotencyKey` — HCM MUST return the prior result for any
   * retry with the same key (ADR-005, ADR-008).
   *
   * @throws HcmPermanentError with `reason: 'INSUFFICIENT_BALANCE'` if HCM rejects.
   * @throws HcmTransientError on network/5xx — caller should retry.
   * @throws HcmContractViolation if the 2xx response fails schema validation.
   */
  reserveBalance(args: ReserveBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse>;

  /**
   * Credit `units` to the balance (the cancellation path's inverse of
   * {@link reserveBalance}). Same idempotency contract.
   */
  releaseBalance(args: ReleaseBalanceArgs, idempotencyKey: string): Promise<HcmMutationResponse>;

  /**
   * Read the employee's location timeline. Used at request submission to
   * resolve `locationId = locationAt(startDate)` and during lazy bootstrap.
   */
  fetchEmployment(employeeId: string): Promise<HcmEmploymentResponse>;

  /** Read `(leaveTypeId, isActive)` rows valid at the given location. */
  fetchLeaveTypes(locationId: string): Promise<HcmLeaveTypesResponse>;

  /**
   * Read a single employee record. Used exclusively by the lazy-bootstrap
   * path (TRD §11.3). Returns `null` if HCM has no record — adapters MAY
   * throw {@link HcmEmployeeNotFoundError} instead; the bootstrap service
   * accepts both shapes.
   */
  fetchEmployee(employeeId: string): Promise<HcmEmployeeResponse>;

  /**
   * Stream the full daily balance corpus. Implementations paginate
   * transparently — the consumer iterates the stream until completion.
   *
   * @param cursor opaque resume token from a prior partial drain; omit on
   *   first call.
   */
  fetchBatch(cursor?: string): AsyncIterable<HcmBatchEntry>;

  /**
   * **Rev 3 (ADR-018).** Pre-flight transaction-history lookup used by the
   * provisional reconciler.
   *
   * Filter `idempotencyKey` to ask "did HCM apply MY action?" — the result
   * is at most one record. The optional `window` bounds the search; the
   * reconciler passes `[invokedAt - reconciler.historyQueryWindowMs, now()]`
   * (default 24h, ADR-024).
   *
   * @ref docs/01_TRD.md §13.2.1, §9.5.3
   */
  queryTransactions(query: HcmTransactionQuery): Promise<HcmTransactionRecord[]>;
}
