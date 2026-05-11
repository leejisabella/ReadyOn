/**
 * Nest DI token for the shared `better-sqlite3` Database handle. Defined in
 * its own file so stores can import without pulling in the module itself
 * (which would create a circular dependency).
 */
export const DATABASE = 'MOCK_HCM_DATABASE';
