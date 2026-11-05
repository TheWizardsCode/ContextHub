/**
 * init content — AGENTS/WORKFLOW content normalisation and analysis.
 *
 * Single responsibility: normalise file content read from templates or an
 * existing project file (line endings, trailing whitespace) and analyse an
 * existing AGENTS.md for the canonical global-agent reference structure.
 */

import { CANONICAL_GLOBAL_REFERENCE_LINE, CANONICAL_GLOBAL_REFERENCE_MARKER } from './init.constants.js';

export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

export function analyzeAgentContent(existingContent: string): { hasGlobalReference: boolean; trimmed: string; eol: string; hasOnlyWhitespace: boolean } {
  const lines = existingContent.split(/\r?\n/);
  const firstNonEmpty = lines.find(line => line.trim().length > 0);
  const eol = existingContent.includes('\r\n') ? '\r\n' : '\n';
  return {
    // Detect the canonical global-reference structure (template emits
    // "## Global agent guidance" referencing ~/.pi/agent/AGENTS.md). Also
    // treat the legacy pointer line as already-referenced so previously
    // installed projects stay idempotent on re-run.
    hasGlobalReference:
      existingContent.includes(CANONICAL_GLOBAL_REFERENCE_MARKER) ||
      existingContent.includes(CANONICAL_GLOBAL_REFERENCE_LINE) ||
      firstNonEmpty?.startsWith('Follow the global AGENTS.md') === true,
    trimmed: existingContent.trimEnd(),
    eol,
    hasOnlyWhitespace: firstNonEmpty === undefined
  };
}
