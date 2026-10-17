// packages/herdr/src/__fixtures__/stale-shared.mjs
//
// Fixture reproducing a STALE vendored @worklog/shared module
// (WL-0MVAY631M004RZ3Q): the module used to export a different surface and
// is missing the export the plugin's entry point imports.
export const legacyStatusIcon = () => 'stale';
