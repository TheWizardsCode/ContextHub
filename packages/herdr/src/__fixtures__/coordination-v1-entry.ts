// packages/herdr/src/__fixtures__/coordination-v1-entry.ts
//
// Legacy v1 coordination-entry fixture (parent WL-0MWDDHQON0015T3P AC1/AC9,
// test-first slice WL-0MWDVMK48002NIHO).
//
// Before the v2 upgrade a coordination file entry carried ONE top-level
// `workItemId` and NO `offers` payload, with `COORDINATION_FILE_VERSION = 1`.
// The v2 reader must migrate-read such an entry as a one-offer entry whose
// kind is derived by the classifier (parent AC1), and a v2-aware leader must
// dispatch it UNCHANGED (parent AC9) — this fixture is the shared witness for
// both contracts: the schema/migration unit tests in `coordination.test.ts`
// and the leader-side legacy-dispatch tests in `coordination-leader.test.ts`.
//
// `LEGACY_V1_ITEM` is the fetched-item descriptor the classifier would see
// for the offered item: `classifyItemForDispatch` maps it deterministically
// to the `implement` bucket (open / plan_complete / Low risk / S effort), so
// the migration-read's "kind derived by the classifier" is pinned exactly.

import type { CoordinationEntry } from '../coordination.js';

export const LEGACY_V1_INSTANCE_ID = 'inst-legacy';
export const LEGACY_V1_WORK_ITEM_ID = 'WL-LEGACY-OFFER';

/** A v1 file entry exactly as a pre-upgrade writer persisted it. */
export const LEGACY_V1_ENTRY: CoordinationEntry = {
  instanceId: LEGACY_V1_INSTANCE_ID,
  workItemId: LEGACY_V1_WORK_ITEM_ID,
  // Legacy per-worklog files carry only `directory` — never `worklogRoot`.
  directory: '/repo/legacy-root',
  assignedAt: '2026-11-11T00:00:00.000Z',
  lastUpdated: '2026-11-12T12:00:00.000Z',
};

/** The fetched-item descriptor for the legacy offer (deterministic `implement` classification). */
export const LEGACY_V1_ITEM: {
  id: string;
  title: string;
  status: string;
  stage: string;
  risk: string;
  effort: string;
} = {
  id: LEGACY_V1_WORK_ITEM_ID,
  title: 'Legacy offered item',
  status: 'open',
  stage: 'plan_complete',
  risk: 'Low',
  effort: 'S',
};
