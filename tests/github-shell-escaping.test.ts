/**
 * Regression tests for shell escaping in the GitHub command builders
 * (WL-0MW0QXTYD0065ZW7).
 *
 * The bug: issue titles, assignees and label names were interpolated into
 * `gh …` command *strings* with `JSON.stringify()`. That escapes only the
 * characters special inside a JSON/JavaScript double-quoted string — quotes,
 * backslashes, control characters — and **not** `$`, backticks or `!`. Embedded
 * in a shell double-quoted context, `$(…)`, backticks and `${…}` were still
 * substituted by `/bin/bash`, so a work-item title like
 * `Fix $(touch /tmp/pwned)` executed a command on `wl gh push`.
 *
 * These tests exercise the real builders end-to-end: they put a stub `gh` first
 * on `PATH`, call the builder, and inspect the *argv the stub actually
 * received*. An argv check is the only evidence that matters, because the shell
 * has already finished by then:
 *
 * - with the old escaping, `$(…)` / backticks are substituted (the argv loses
 *   the payload and the side-effecting file appears);
 * - with `quoteShellValue()` the argv element is byte-identical to the payload
 *   and nothing is executed.
 *
 * Covered builders: issue create (sync + async), issue edit title/labels
 * (sync + async), assignment (sync + async) and label creation (sync + async,
 * both the `gh api` path and the `gh issue label create` fallback).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assignGithubIssue,
  assignGithubIssueAsync,
  createGithubIssue,
  createGithubIssueAsync,
  updateGithubIssue,
  updateGithubIssueAsync,
} from '../src/github/issues.js';
import { ensureGithubLabels, ensureGithubLabelsAsync } from '../src/github/labels.js';

/**
 * Stub `gh` CLI. Records every invocation's argv (and stdin) as one JSON line
 * in `$GH_STUB_LOG`, then answers with the minimal payload each code path
 * expects. It never parses its arguments the way the real `gh` would, which is
 * exactly what lets the tests assert the argv the shell produced.
 */
const GH_STUB = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (_) {}
if (process.env.GH_STUB_LOG) {
  fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify({ args, stdin }) + '\\n');
}
const labels = process.env.GH_STUB_VIEW_LABELS ? JSON.parse(process.env.GH_STUB_VIEW_LABELS) : [];
const [cmd, sub] = args;
if (cmd === 'issue') {
  if (sub === 'view') {
    const number = Number((args.find(a => /^[0-9]+$/.test(a)) || '1'));
    process.stdout.write(JSON.stringify({
      number,
      id: 'ISSUE_' + number,
      title: process.env.GH_STUB_VIEW_TITLE || 'Existing issue',
      body: 'existing body',
      state: 'open',
      labels: labels.map(name => ({ name })),
      updatedAt: '2025-01-01T00:00:00Z',
    }) + '\\n');
    process.exit(0);
  }
  if (sub === 'create') {
    process.stdout.write('https://github.com/owner/repo/issues/7\\n');
    process.exit(0);
  }
  process.exit(0);
}
if (cmd === 'api') {
  if (process.env.GH_STUB_API_FAIL === '1' && args.includes('POST')) process.exit(1);
  if (args.includes('--paginate')) { process.stdout.write('[]\\n'); process.exit(0); }
  process.stdout.write('{}\\n'); process.exit(0);
}
if (cmd === 'repo') { process.stdout.write('{"nameWithOwner":"owner/repo"}\\n'); process.exit(0); }
process.exit(0);
`;

interface StubCall {
  args: string[];
  stdin: string;
}

interface Injection {
  /** Payload containing `$(…)`, a backtick substitution, `${HOME}` and operators. */
  value: string;
  /** Files the payload would create if the shell substituted it. */
  markers: string[];
}

let tmpDir: string;
let logPath: string;
let originalPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-gh-escape-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), GH_STUB, { mode: 0o755 });
  logPath = path.join(tmpDir, 'gh-calls.jsonl');

  originalPath = process.env.PATH || '';
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.GH_STUB_LOG = logPath;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.GH_STUB_LOG;
  delete process.env.GH_STUB_VIEW_LABELS;
  delete process.env.GH_STUB_VIEW_TITLE;
  delete process.env.GH_STUB_API_FAIL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a shell-metacharacter payload whose substitution would create files. */
function makeInjection(tag: string): Injection {
  const dollarMarker = path.join(tmpDir, `injected-dollar-${tag}`);
  const backtickMarker = path.join(tmpDir, `injected-backtick-${tag}`);
  // \\${HOME} must survive verbatim; a substitution would replace it with $HOME.
  const value = `evil$(touch ${dollarMarker}) \`touch ${backtickMarker}\` \${HOME} ! ; | &`;
  return { value, markers: [dollarMarker, backtickMarker] };
}

function readCalls(): StubCall[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as StubCall);
}

/** The argv element following `flag` in the (single) matching call. */
function argAfter(call: StubCall, flag: string): string | undefined {
  const index = call.args.indexOf(flag);
  return index >= 0 ? call.args[index + 1] : undefined;
}

function expectNothingExecuted(injection: Injection): void {
  for (const marker of injection.markers) {
    expect(fs.existsSync(marker)).toBe(false);
  }
}

describe('GitHub command builders pass user text literally to gh', () => {
  it('quotes the issue title on the synchronous create path', () => {
    const injection = makeInjection('create-sync');
    createGithubIssue(
      { repo: 'owner/create-sync', labelPrefix: 'wl:' },
      { title: injection.value, body: 'body', labels: [] },
    );

    const create = readCalls().find(call => call.args[0] === 'issue' && call.args[1] === 'create');
    expect(create).toBeDefined();
    expect(argAfter(create!, '--title')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the issue title and label list on the asynchronous create path', async () => {
    const injection = makeInjection('create-async');
    await createGithubIssueAsync(
      { repo: 'owner/create-async', labelPrefix: 'wl:' },
      { title: injection.value, body: 'body', labels: [injection.value] },
    );

    const calls = readCalls();
    const create = calls.find(call => call.args[0] === 'issue' && call.args[1] === 'create');
    expect(argAfter(create!, '--title')).toBe(injection.value);

    const labelCreate = calls.find(call => call.args[0] === 'api' && call.args.includes('POST'));
    expect(labelCreate).toBeDefined();
    expect(labelCreate!.args).toContain(`name=${injection.value}`);

    const edit = calls.find(call => call.args[0] === 'issue' && call.args[1] === 'edit');
    expect(argAfter(edit!, '--add-label')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the title, added labels and removed labels on the synchronous edit path', () => {
    const injection = makeInjection('update-sync');
    process.env.GH_STUB_VIEW_LABELS = JSON.stringify([`wl:stage:${injection.value}`]);

    updateGithubIssue(
      { repo: 'owner/update-sync', labelPrefix: 'wl:' },
      7,
      { title: injection.value, body: 'new body', labels: [injection.value], state: 'open' },
    );

    const edits = readCalls().filter(call => call.args[0] === 'issue' && call.args[1] === 'edit');
    const titleEdit = edits.find(call => call.args.includes('--title'));
    expect(argAfter(titleEdit!, '--title')).toBe(injection.value);
    const removeEdit = edits.find(call => call.args.includes('--remove-label'));
    expect(argAfter(removeEdit!, '--remove-label')).toBe(`wl:stage:${injection.value}`);
    const addEdit = edits.find(call => call.args.includes('--add-label'));
    expect(argAfter(addEdit!, '--add-label')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the title and added labels on the asynchronous edit path', async () => {
    const injection = makeInjection('update-async');
    await updateGithubIssueAsync(
      { repo: 'owner/update-async', labelPrefix: 'wl:' },
      8,
      { title: injection.value, body: 'new body', labels: [injection.value], state: 'open' },
    );

    const edits = readCalls().filter(call => call.args[0] === 'issue' && call.args[1] === 'edit');
    const titleEdit = edits.find(call => call.args.includes('--title'));
    expect(argAfter(titleEdit!, '--title')).toBe(injection.value);
    const addEdit = edits.find(call => call.args.includes('--add-label'));
    expect(argAfter(addEdit!, '--add-label')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the assignee on the synchronous assignment path', () => {
    const injection = makeInjection('assign-sync');
    assignGithubIssue({ repo: 'owner/assign-sync', labelPrefix: 'wl:' }, 9, injection.value);

    const edit = readCalls().find(call => call.args[0] === 'issue' && call.args[1] === 'edit');
    expect(argAfter(edit!, '--add-assignee')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the assignee on the asynchronous assignment path', async () => {
    const injection = makeInjection('assign-async');
    await assignGithubIssueAsync({ repo: 'owner/assign-async', labelPrefix: 'wl:' }, 10, injection.value);

    const edit = readCalls().find(call => call.args[0] === 'issue' && call.args[1] === 'edit');
    expect(argAfter(edit!, '--add-assignee')).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the label name on the synchronous label-creation path and its fallback', () => {
    const injection = makeInjection('labels-sync');
    // The `gh api -X POST` path fails so the `gh issue label create` fallback runs too.
    process.env.GH_STUB_API_FAIL = '1';

    ensureGithubLabels({ repo: 'owner/labels-sync', labelPrefix: 'wl:' }, [injection.value]);

    const calls = readCalls();
    const apiCreate = calls.find(call => call.args[0] === 'api' && call.args.includes('POST'));
    expect(apiCreate).toBeDefined();
    expect(apiCreate!.args).toContain(`name=${injection.value}`);

    const fallback = calls.find(
      call => call.args[0] === 'issue' && call.args[1] === 'label' && call.args[2] === 'create',
    );
    expect(fallback).toBeDefined();
    expect(fallback!.args[3]).toBe(injection.value);
    expectNothingExecuted(injection);
  });

  it('quotes the label name on the asynchronous label-creation path', async () => {
    const injection = makeInjection('labels-async');
    await ensureGithubLabelsAsync({ repo: 'owner/labels-async', labelPrefix: 'wl:' }, [injection.value]);

    const apiCreate = readCalls().find(call => call.args[0] === 'api' && call.args.includes('POST'));
    expect(apiCreate).toBeDefined();
    expect(apiCreate!.args).toContain(`name=${injection.value}`);
    expectNothingExecuted(injection);
  });

  it('preserves single quotes in a title instead of breaking the command', () => {
    const title = "it's a 'quoted' title; still literal";
    createGithubIssue(
      { repo: 'owner/quotes', labelPrefix: 'wl:' },
      { title, body: 'body', labels: [] },
    );

    const create = readCalls().find(call => call.args[0] === 'issue' && call.args[1] === 'create');
    expect(argAfter(create!, '--title')).toBe(title);
  });
});
