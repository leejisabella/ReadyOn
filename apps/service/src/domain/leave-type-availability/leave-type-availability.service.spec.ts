import type { Database } from 'better-sqlite3';
import { makeServiceTestDb } from '../../../test/db-helper';
import {
  LeaveTypeAvailabilityService,
  type LeaveTypeAvailabilitySnapshot,
} from './leave-type-availability.service';
import { LeaveTypeAvailabilityStore } from './leave-type-availability.store';

const snap = (
  overrides: Partial<LeaveTypeAvailabilitySnapshot> = {},
): LeaveTypeAvailabilitySnapshot => ({
  locationId: 'loc-1',
  leaveTypeId: 'pto',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  isActive: true,
  hcmVersion: 1n,
  ...overrides,
});

describe('LeaveTypeAvailabilityService', () => {
  let db: Database;
  let service: LeaveTypeAvailabilityService;

  beforeEach(() => {
    db = makeServiceTestDb();
    service = new LeaveTypeAvailabilityService(new LeaveTypeAvailabilityStore(db));
  });

  afterEach(() => db.close());

  describe('isActive', () => {
    it('is false for an unknown (location, leaveType) pair', () => {
      expect(service.isActive('loc-x', 'pto', '2025-06-01')).toBe(false);
    });

    it('is true inside an active open-ended period', () => {
      service.applyHcmUpdate(snap());
      expect(service.isActive('loc-1', 'pto', '2030-01-01')).toBe(true);
    });

    it('is false before the period starts', () => {
      service.applyHcmUpdate(snap({ effectiveFrom: '2025-06-01' }));
      expect(service.isActive('loc-1', 'pto', '2025-05-31')).toBe(false);
    });

    it('is false after a closed-and-active period ends', () => {
      service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
      expect(service.isActive('loc-1', 'pto', '2025-06-01')).toBe(false);
    });

    it('is false when the most-recent covering period is explicitly deactivated', () => {
      service.applyHcmUpdate(snap({ effectiveTo: '2025-05-31' }));
      service.applyHcmUpdate(
        snap({ effectiveFrom: '2025-06-01', isActive: false, hcmVersion: 2n }),
      );
      expect(service.isActive('loc-1', 'pto', '2025-06-15')).toBe(false);
    });

    it('isolates per (location, leaveType) pair', () => {
      service.applyHcmUpdate(snap({ locationId: 'loc-A', leaveTypeId: 'pto' }));
      service.applyHcmUpdate(snap({ locationId: 'loc-B', leaveTypeId: 'pto', isActive: false }));
      expect(service.isActive('loc-A', 'pto', '2025-06-01')).toBe(true);
      expect(service.isActive('loc-B', 'pto', '2025-06-01')).toBe(false);
    });
  });

  describe('listForLocation', () => {
    it('returns every period across leave types ordered by leaveType then effectiveFrom', () => {
      service.applyHcmUpdate(snap({ leaveTypeId: 'sick' }));
      service.applyHcmUpdate(snap({ leaveTypeId: 'pto' }));
      expect(service.listForLocation('loc-1').map((r) => r.leaveTypeId)).toEqual(['pto', 'sick']);
    });
  });

  describe('applyHcmUpdate', () => {
    it('returns true on insert', () => {
      expect(service.applyHcmUpdate(snap())).toBe(true);
    });

    it('returns false on equal-version replay', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 1n }));
      expect(service.applyHcmUpdate(snap({ hcmVersion: 1n }))).toBe(false);
    });

    it('returns true on newer version and applies isActive flip', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 1n }));
      expect(service.applyHcmUpdate(snap({ isActive: false, hcmVersion: 2n }))).toBe(true);
      expect(service.isActive('loc-1', 'pto', '2025-06-01')).toBe(false);
    });

    it('returns false on stale event arriving out of order', () => {
      service.applyHcmUpdate(snap({ hcmVersion: 10n }));
      expect(service.applyHcmUpdate(snap({ isActive: false, hcmVersion: 5n }))).toBe(false);
      expect(service.isActive('loc-1', 'pto', '2025-06-01')).toBe(true);
    });
  });
});
