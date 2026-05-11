import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import { EmploymentService, type EmploymentSnapshot } from './employment.service';
import { EmploymentStore } from './employment.store';

const snap = (overrides: Partial<EmploymentSnapshot> = {}): EmploymentSnapshot => ({
  employeeId: 'emp-1',
  locationId: 'loc-A',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  hcmVersion: 1n,
  ...overrides,
});

describe('EmploymentService', () => {
  let db: Database;
  let service: EmploymentService;

  beforeEach(() => {
    db = makeServiceTestDb();
    service = new EmploymentService(new EmploymentStore(db));
  });

  afterEach(() => db.close());

  describe('locationAt (TRD §12.2)', () => {
    it('returns null when the employee has no employment yet', () => {
      expect(service.locationAt('emp-x', '2025-06-01')).toBeNull();
    });

    it('returns the location for an open-ended period extending into the future', () => {
      service.applyHcmUpdate(snap());
      expect(service.locationAt('emp-1', '2030-01-01')).toBe('loc-A');
    });

    it('returns null before the period starts', () => {
      service.applyHcmUpdate(snap({ effectiveFrom: '2025-06-01' }));
      expect(service.locationAt('emp-1', '2025-05-31')).toBeNull();
    });

    it('returns null after a closed period ends', () => {
      service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
      expect(service.locationAt('emp-1', '2025-06-01')).toBeNull();
    });

    describe('contiguous transfer (TRD §12.3 boundary semantics)', () => {
      beforeEach(() => {
        service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
        service.applyHcmUpdate(
          snap({ locationId: 'loc-B', effectiveFrom: '2025-06-01', hcmVersion: 2n }),
        );
      });

      it('returns old location on the day BEFORE the transfer', () => {
        expect(service.locationAt('emp-1', '2025-05-31')).toBe('loc-A');
      });

      it('returns new location on the transfer day itself', () => {
        expect(service.locationAt('emp-1', '2025-06-01')).toBe('loc-B');
      });

      it('returns old location in the middle of the old period', () => {
        expect(service.locationAt('emp-1', '2025-03-15')).toBe('loc-A');
      });

      it('returns new location after the transfer', () => {
        expect(service.locationAt('emp-1', '2026-01-01')).toBe('loc-B');
      });
    });

    it('returns null inside a gap between historical periods', () => {
      service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
      service.applyHcmUpdate(
        snap({ locationId: 'loc-C', effectiveFrom: '2025-09-01', hcmVersion: 2n }),
      );
      expect(service.locationAt('emp-1', '2025-07-15')).toBeNull();
    });

    it('isolates per employee', () => {
      service.applyHcmUpdate(snap({ employeeId: 'emp-a' }));
      service.applyHcmUpdate(snap({ employeeId: 'emp-b', locationId: 'loc-Z', hcmVersion: 2n }));
      expect(service.locationAt('emp-a', '2025-06-01')).toBe('loc-A');
      expect(service.locationAt('emp-b', '2025-06-01')).toBe('loc-Z');
    });
  });

  describe('history', () => {
    it('returns an empty array when the employee is unknown', () => {
      expect(service.history('emp-x')).toEqual([]);
    });

    it('returns every period ordered by effectiveFrom ascending', () => {
      service.applyHcmUpdate(snap({ locationId: 'loc-B', effectiveFrom: '2025-06-01', hcmVersion: 2n }));
      service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
      const history = service.history('emp-1');
      expect(history.map((p) => p.locationId)).toEqual(['loc-A', 'loc-B']);
    });
  });

  describe('applyHcmUpdate', () => {
    it('returns true on first apply', () => {
      expect(service.applyHcmUpdate(snap())).toBe(true);
    });

    it('returns false on an exact replay at the same version', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 1n }));
      expect(service.applyHcmUpdate(snap({ hcmVersion: 1n }))).toBe(false);
    });

    it('returns true when a newer version supersedes the current row', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 1n }));
      expect(
        service.applyHcmUpdate(snap({ effectiveTo: '2025-12-31', hcmVersion: 2n })),
      ).toBe(true);
    });

    it('returns false on a stale event (older version arrives out of order)', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 5n }));
      expect(service.applyHcmUpdate(snap({ locationId: 'loc-STALE', hcmVersion: 4n }))).toBe(false);
      expect(service.locationAt('emp-1', '2025-06-01')).toBe('loc-A'); // unchanged
    });
  });
});
