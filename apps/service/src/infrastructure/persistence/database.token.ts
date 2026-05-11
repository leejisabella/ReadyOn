/**
 * Nest DI token for the service's `better-sqlite3` handle. Defined separately
 * from the module so stores can inject without a circular import.
 */
export const DATABASE = 'TIME_OFF_DATABASE';
