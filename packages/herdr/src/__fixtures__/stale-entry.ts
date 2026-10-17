// packages/herdr/src/__fixtures__/stale-entry.ts
//
// Fixture entry point that imports a named export which the (stale) shared
// module above does not provide. Loading this module fails with exactly the
// ESM SyntaxError the real plugin hit when its vendored @worklog/shared was
// stale:
//
//   SyntaxError: The requested module '...' does not provide an export
//   named 'needsProducerReviewIcon'
//
// The pane launcher (src/start.ts) must surface this as an actionable
// diagnostic instead of letting the pane die silently.
//
// NOTE: this fixture is excluded from the herdr tsconfig (src/__fixtures__)
// because the missing export is the very failure it simulates.
import { needsProducerReviewIcon } from './stale-shared.mjs';

console.log(needsProducerReviewIcon);
