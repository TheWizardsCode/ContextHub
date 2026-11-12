// packages/herdr/src/__fixtures__/coordination-v2-offers.ts
//
// v2 coordination `offers` payload fixtures (parent WL-0MWDDHQON0015T3P AC1,
// test-first slice WL-0MWDVMK48002NIHO).
//
// The v2 entry contract: each entry still belongs to ONE instance, but the
// offer payload is a bounded `offers` array — at most one nominee per bucket
// (`implement` / `audit` / `prep`, the classifier outputs with
// plan/intake/risk-effort unioning to `prep`), at most three offers total,
// and duplicate `(kind, workItemId)` pairs collapse. `CoordinationOffer`
// does not exist until the schema implementation (sibling
// WL-0MWDVMVX50012RSU), so the witness shape is declared here and shared by
// the schema tests in `coordination.test.ts`.

/** The v2 per-bucket offer payload F1 introduces (at most one per bucket). */
export type CoordOfferWitness = {
  kind: 'implement' | 'audit' | 'prep';
  workItemId: string;
};

/** The canonical bounded shape: one nominee per bucket, three offers. */
export const CANONICAL_V2_OFFERS: CoordOfferWitness[] = [
  { kind: 'implement', workItemId: 'WL-IMP' },
  { kind: 'audit', workItemId: 'WL-AUD' },
  { kind: 'prep', workItemId: 'WL-PREP' },
];

/** Duplicate `(kind, workItemId)` pairs — must collapse to one offer on write. */
export const DUPLICATE_V2_OFFERS: CoordOfferWitness[] = [
  { kind: 'implement', workItemId: 'WL-IMP' },
  { kind: 'implement', workItemId: 'WL-IMP' },
  { kind: 'audit', workItemId: 'WL-AUD' },
  { kind: 'prep', workItemId: 'WL-PREP' },
];

/** Two offers in the SAME bucket — violates the one-per-bucket bound. */
export const OVER_BUCKET_V2_OFFERS: CoordOfferWitness[] = [
  { kind: 'implement', workItemId: 'WL-IMP-A' },
  { kind: 'implement', workItemId: 'WL-IMP-B' },
];

/** Four offers — violates the three-offer bound (and the implement bucket twice). */
export const OVER_CAP_V2_OFFERS: CoordOfferWitness[] = [
  { kind: 'implement', workItemId: 'WL-IMP' },
  { kind: 'audit', workItemId: 'WL-AUD' },
  { kind: 'prep', workItemId: 'WL-PREP' },
  { kind: 'implement', workItemId: 'WL-IMP-2' },
];
