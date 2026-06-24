/**
 * Backward-compatible re-export shim.
 *
 * Pi loads the extension from Worklog/index.ts via the package.json manifest,
 * deriving the display label "Worklog" from the entry-point path.
 *
 * This file provides backward compatibility for test files and external
 * consumers that import from the previous location (extensions/index.ts).
 * All canonical exports are forwarded from the Worklog/ entry point.
 *
 * @module
 */

export * from './Worklog/index.js';
export { default } from './Worklog/index.js';
