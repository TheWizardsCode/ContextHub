/**
 * lib/skill-path.ts — Skill path discovery helper for the Worklog Pi extension.
 *
 * Provides:
 * - `discoverSkillPath(skillName)`: Synchronous lookup across known locations
 * - `registerSkillPathTool()`: Returns a tool definition compatible with `pi.registerTool()`
 * - `clearSkillPathCache()`: Clears the session-level cache
 *
 * The tool checks these locations (in order):
 * 1. `~/.pi/agent/skills/<skillName>/` — global skills directory
 * 2. `<cwd>/.pi/skills/<skillName>/` — project-local skills directory
 *
 * Discovered paths are cached in memory for the duration of the session to
 * avoid repeated filesystem scans.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Cache entry storing either a discovered path or a sentinel for "not found".
 */
type CacheEntry =
  | { found: true; path: string }
  | { found: false };

// ── Session-level cache ───────────────────────────────────────────────

/**
 * In-memory cache for skill paths, scoped to the session lifetime.
 * Keyed by skill name, stores either the discovered path or a "not found" sentinel.
 */
const pathCache = new Map<string, CacheEntry>();

// ── Location discovery ────────────────────────────────────────────────

/**
 * Get the ordered list of locations to search for a given skill.
 *
 * Global path is checked first (user-level installation), followed by
 * project-local path (per-project skill overrides or development).
 */
function getSkillLocations(skillName: string): string[] {
  return [
    path.join(os.homedir(), '.pi', 'agent', 'skills', skillName),
    path.join(process.cwd(), '.pi', 'skills', skillName),
  ];
}

// ── Core discovery function ───────────────────────────────────────────

/**
 * Discover the installation directory for a skill by checking known locations.
 *
 * Checks these locations in order:
 * 1. `~/.pi/agent/skills/<skillName>/` — global skills directory
 * 2. `<cwd>/.pi/skills/<skillName>/` — project-local skills directory
 *
 * Results are cached in memory for the session lifetime. Use
 * `clearSkillPathCache()` to invalidate the cache.
 *
 * @param skillName - The name of the skill to locate
 * @returns The full path to the skill's directory
 * @throws {Error} If the skill is not found in any known location
 */
export function discoverSkillPath(skillName: string): string {
  // Check cache first
  const cached = pathCache.get(skillName);
  if (cached !== undefined) {
    if (cached.found) {
      return cached.path;
    }
    throw new Error(`Skill not found: ${skillName}`);
  }

  // Search locations
  const locations = getSkillLocations(skillName);
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      pathCache.set(skillName, { found: true, path: loc });
      return loc;
    }
  }

  // Not found — cache negative result
  pathCache.set(skillName, { found: false });
  throw new Error(`Skill not found: ${skillName}`);
}

// ── Cache management ──────────────────────────────────────────────────

/**
 * Clear the session-level skill path cache.
 *
 * Call this if skills are installed or removed during a session and you
 * want the next lookup to re-check the filesystem.
 */
export function clearSkillPathCache(): void {
  pathCache.clear();
}

// ── Tool registration ─────────────────────────────────────────────────

/**
 * Create a tool definition for the `skill_path` tool, compatible with
 * `pi.registerTool()`.
 *
 * The tool accepts a `skillName` string parameter and returns the absolute
 * path to the skill's installation directory. If the skill cannot be found
 * in any known location, it returns an error message in the tool result.
 *
 * @returns A tool definition object ready for `pi.registerTool()`
 */
export function registerSkillPathTool() {
  return {
    name: 'skill_path',
    label: 'Skill Path',
    description:
      'Get the installation directory for a skill. ' +
      'Searches ~/.pi/agent/skills/<name>/ and <cwd>/.pi/skills/<name>/ ' +
      'and caches the result for the session lifetime.',
    parameters: {
      type: 'object',
      required: ['skillName'],
      properties: {
        skillName: {
          type: 'string',
          description: 'Name of the skill to locate (e.g., "implement", "audit")',
        },
      },
    },
    execute: async (
      _toolCallId: string,
      params: { skillName: string },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      _ctx?: unknown,
    ) => {
      try {
        const skillPath = discoverSkillPath(params.skillName);
        return {
          content: [{ type: 'text' as const, text: skillPath }],
          details: { skillName: params.skillName, path: skillPath },
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : `Skill not found: ${params.skillName}`;
        return {
          content: [{ type: 'text' as const, text: message }],
          details: { skillName: params.skillName, error: message },
          isError: true,
        };
      }
    },
  };
}
