/**
 * Contract tests for the `wl sync` author-identity whitelist
 * (WL-0MVM92MZ50075E6B).
 *
 * `refs/worklog/data` is written by more than one environment, so its history
 * legitimately carries commits from two identities: the operator
 * (`250240+SorraTheOrc@users.noreply.github.com`) and the agent store
 * (`pi@local`). The author-identity gate refuses to merge commits whose author
 * is neither the store's local `user.email` nor an entry in
 * `syncAllowedAuthors`, so the value this repository actually ships must list
 * both identities.
 *
 * These tests read the *tracked* configuration and drive the *real*
 * `loadConfigRelaxed()` merge and `checkAuthorIdentity()` gate, so a drift in
 * the package's behaviour or in the committed config fails the suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { loadConfigRelaxed } from '../src/config.js';
import { checkAuthorIdentity } from '../src/sync.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(REPO_ROOT, '.worklog', 'config.yaml');
const DEFAULTS_FILE = path.join(REPO_ROOT, '.worklog', 'config.defaults.yaml');
const REMOTE_TRACKING_REF = 'refs/worklog/remotes/origin/worklog/data';

const OPERATOR_AUTHOR = '250240+SorraTheOrc@users.noreply.github.com';
const AGENT_AUTHOR = 'pi@local';
const KNOWN_AUTHORS = [OPERATOR_AUTHOR, AGENT_AUTHOR];
const UNKNOWN_AUTHOR = 'intruder@example.com';

/** Parse a tracked worklog YAML config file. */
function readConfigFile(file: string): Record<string, unknown> {
  return (yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>) ?? {};
}

/** Run the real gate for one author against a whitelist. */
function gateAllows(authorEmail: string, allowedAuthors: string[] | null, allowForeignAuthor = false): boolean {
  return checkAuthorIdentity(
    [{ hash: 'deadbeef', authorEmail }],
    {
      remoteTrackingRef: REMOTE_TRACKING_REF,
      expectedAuthorEmail: OPERATOR_AUTHOR,
      allowForeignAuthor,
      allowedAuthors,
    }
  ).allowed;
}

/** The whitelist the CLI resolves for this repository (defaults + config.yaml). */
function effectiveAllowedAuthors(): unknown {
  const originalCwd = process.cwd();
  try {
    process.chdir(REPO_ROOT);
    const config = loadConfigRelaxed();
    expect(config, 'loadConfigRelaxed() must load this repository\'s .worklog config').not.toBeNull();
    return config?.syncAllowedAuthors;
  } finally {
    process.chdir(originalCwd);
  }
}

describe('sync author-identity whitelist (WL-0MVM92MZ50075E6B)', () => {
  describe('tracked configuration', () => {
    it('declares a narrow list of the two known identities in config.yaml or config.defaults.yaml', () => {
      const declared =
        readConfigFile(CONFIG_FILE).syncAllowedAuthors ??
        readConfigFile(DEFAULTS_FILE).syncAllowedAuthors;

      expect(Array.isArray(declared), `syncAllowedAuthors must be a list, got ${String(declared)}`).toBe(true);
      const list = declared as unknown[];
      expect(list.length, 'syncAllowedAuthors must not be empty (strict mode)').toBeGreaterThan(0);
      expect(list, 'syncAllowedAuthors must not be allow-all (true/null)').not.toContain(true);
      for (const entry of list) {
        expect(typeof entry === 'string' && entry.trim() !== '', `entry must be a non-empty string: ${String(entry)}`)
          .toBe(true);
      }
      for (const author of KNOWN_AUTHORS) {
        expect(list, `${author} must be whitelisted`).toContain(author);
      }
    });

    it('resolves both known identities after the defaults/user merge', () => {
      const effective = effectiveAllowedAuthors();
      expect(effective, 'effective syncAllowedAuthors must not be null/allow-all').not.toBeNull();
      expect(Array.isArray(effective), `effective syncAllowedAuthors must be a list, got ${String(effective)}`).toBe(true);
      for (const author of KNOWN_AUTHORS) {
        expect(effective as string[], `${author} must survive the defaults/user merge`).toContain(author);
      }
    });

    it('config.yaml never shadows a defaults entry with a narrower list', () => {
      const fromDefaults = readConfigFile(DEFAULTS_FILE).syncAllowedAuthors;
      const fromConfig = readConfigFile(CONFIG_FILE).syncAllowedAuthors;
      if (fromDefaults === undefined || fromConfig === undefined) return; // no shadowing possible
      const defaultsList = (fromDefaults as string[]) ?? [];
      expect(Array.isArray(fromConfig)).toBe(true);
      for (const author of defaultsList) {
        expect(fromConfig as string[], `config.yaml shadows the defaults and drops ${author}`).toContain(author);
      }
    });
  });

  describe('author-identity gate', () => {
    it('accepts the whitelisted agent author and the local author', () => {
      const allowed = effectiveAllowedAuthors() as string[];
      expect(gateAllows(AGENT_AUTHOR, allowed)).toBe(true);
      expect(gateAllows(OPERATOR_AUTHOR, allowed)).toBe(true);
    });

    it('still refuses an unlisted author (the list is not allow-all)', () => {
      const allowed = effectiveAllowedAuthors() as string[];
      expect(gateAllows(UNKNOWN_AUTHOR, allowed)).toBe(false);
    });

    it('refuses an empty author unconditionally, even with the allow-all override', () => {
      const allowed = effectiveAllowedAuthors() as string[];
      expect(gateAllows('', allowed)).toBe(false);
      expect(gateAllows('', allowed, true)).toBe(false);
    });
  });
});
