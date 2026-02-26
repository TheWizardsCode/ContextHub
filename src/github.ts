import { execSync, spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkItem, Comment, WorkItemStatus, WorkItemPriority } from './types.js';

export interface GithubConfig {
  repo: string;
  labelPrefix: string;
}

export interface GithubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  updatedAt: string;
  subIssuesSummary?: { total: number; completed: number };
}

export interface GithubIssueComment {
  id: number;
  body: string | null;
  updatedAt: string;
  author?: string;
}

const WORKLOG_MARKER_PREFIX = '<!-- worklog:id=';
const WORKLOG_MARKER_SUFFIX = ' -->';
const WORKLOG_COMMENT_MARKER_PREFIX = '<!-- worklog:comment=';
const WORKLOG_COMMENT_MARKER_SUFFIX = ' -->';

function runGh(command: string, input?: string): string {
  // For potentially large paginated outputs, stream stdout to a temp file using spawnSync
  // to avoid spawnSync/execSync ENOBUFS or buffer limitations in Node.
  if (command.includes('--paginate')) {
    const outPath = path.join(os.tmpdir(), `worklog-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const errPath = `${outPath}.err`;
    // Open file descriptors for stdout/stderr
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    try {
      const res = spawnSync('/bin/sh', ['-c', command], {
        encoding: 'utf-8',
        stdio: ['pipe', outFd, errFd],
        input,
      });
      const stdout = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf-8').trim() : '';
      if (res.error) {
        const e = res.error as Error;
        e.message = `${e.message}\n${stderr}`;
        throw e;
      }
      if (res.status !== 0) {
        throw new Error(stderr || `gh command failed with exit code ${res.status}`);
      }
      return stdout;
    } finally {
      try { fs.closeSync(outFd); } catch (_) {}
      try { fs.closeSync(errFd); } catch (_) {}
      try { fs.unlinkSync(outPath); } catch (_) {}
      try { fs.unlinkSync(errPath); } catch (_) {}
    }
  }

  return execSync(command, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  }).trim();
}

function runGhDetailed(command: string, input?: string): { ok: boolean; stdout: string; stderr: string } {
  // Use streaming approach for paginate commands to avoid buffer limits
  if (command.includes('--paginate')) {
    const outPath = path.join(os.tmpdir(), `worklog-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const errPath = `${outPath}.err`;
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    try {
      const res = spawnSync('/bin/sh', ['-c', command], {
        encoding: 'utf-8',
        stdio: ['pipe', outFd, errFd],
        input,
      });
      const stdout = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf-8').trim() : '';
      if (!res || res.status !== 0) {
        return { ok: false, stdout, stderr: stderr || `gh command failed with exit code ${res?.status ?? 'unknown'}` };
      }
      return { ok: true, stdout, stderr };
    } catch (err: any) {
      const stderr = err?.message || String(err);
      const stdout = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      return { ok: false, stdout, stderr };
    } finally {
      try { fs.closeSync(outFd); } catch (_) {}
      try { fs.closeSync(errFd); } catch (_) {}
      try { fs.unlinkSync(outPath); } catch (_) {}
      try { fs.unlinkSync(errPath); } catch (_) {}
    }
  }

  try {
    const stdout = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
    }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (error: any) {
    const stdout = (error?.stdout ? String(error.stdout) : '').trim();
    const stderr = (error?.stderr ? String(error.stderr) : error?.message || '').trim();
    return { ok: false, stdout, stderr };
  }
}

// Async variants -----------------------------------------------------------
function spawnCommand(command: string, input?: string, timeout = 120000): Promise<{ stdout: string; stderr: string; code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() || err.message, code: child.exitCode, error: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    if (input) {
      try { child.stdin.write(input); } catch (_) {}
    }
    try { child.stdin.end(); } catch (_) {}
  });
}

async function runGhAsync(command: string, input?: string): Promise<string> {
  // For paginate commands prefer streaming via spawnCommand
  const res = await spawnCommand(command, input);
  if (res.error) throw res.error;
  if (res.code !== 0) throw new Error(res.stderr || `gh command failed with exit code ${res.code}`);
  return res.stdout.trim();
}

async function runGhDetailedAsync(command: string, input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await spawnCommand(command, input);
  if (res.code !== 0) {
    return { ok: false, stdout: res.stdout, stderr: res.stderr || `gh command failed with exit code ${res.code}` };
  }
  return { ok: true, stdout: res.stdout, stderr: res.stderr };
}

// JSON helpers with simple retry/backoff for rate limits
async function runGhJsonDetailedAsync(command: string, input?: string, retries = 3): Promise<{ ok: boolean; data?: any; error?: string }> {
  let attempt = 0;
  let backoff = 500;
  while (attempt <= retries) {
    const res = await runGhDetailedAsync(command, input);
    if (!res.ok) {
      const stderr = res.stderr || '';
      // simple detection of rate limit or 403s
      if (/rate limit|403|API rate limit exceeded/i.test(stderr) && attempt < retries) {
        await new Promise(r => setTimeout(r, backoff));
        attempt += 1;
        backoff *= 2;
        continue;
      }
      return { ok: false, error: stderr || res.stdout || 'GraphQL request failed' };
    }
    try {
      const data = JSON.parse(res.stdout);
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        const message = data.errors.map((entry: any) => entry?.message || String(entry)).join('; ');
        return { ok: false, error: message || 'GraphQL request returned errors' };
      }
      return { ok: true, data };
    } catch (err: any) {
      return { ok: false, error: 'Invalid JSON response from GraphQL' };
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

async function runGhJsonAsync(command: string, input?: string): Promise<any> {
  const output = await runGhAsync(command, input);
  return JSON.parse(output);
}

function runGhSafe(command: string, input?: string): string | null {
  try {
    return runGh(command, input);
  } catch {
    return null;
  }
}

function runGhJson(command: string, input?: string): any {
  const output = runGh(command, input);
  return JSON.parse(output);
}

function runGhSafeJson(command: string, input?: string): any | null {
  const output = runGhSafe(command, input);
  if (output === null || output.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function runGhJsonDetailed(command: string, input?: string): { ok: boolean; data?: any; error?: string } {
  const result = runGhDetailed(command, input);
  if (!result.ok) {
    const error = result.stderr || result.stdout || 'GraphQL request failed';
    return { ok: false, error };
  }
  try {
    const data = JSON.parse(result.stdout);
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const message = data.errors.map((entry: any) => entry?.message || String(entry)).join('; ');
      return { ok: false, error: message || 'GraphQL request returned errors' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Invalid JSON response from GraphQL' };
  }
}

function quoteShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function labelColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const color = (hash % 0xffffff).toString(16).padStart(6, '0');
  return color === '000000' ? 'ededed' : color;
}

/**
 * Known worklog label categories that should be single-valued on an issue.
 * When a new value is pushed for one of these categories the old label must
 * be removed first to avoid label accumulation.
 *
 * `tag:` is intentionally excluded — multiple tags are valid and additive.
 */
const SINGLE_VALUE_LABEL_CATEGORIES = ['status:', 'priority:', 'stage:', 'type:', 'risk:', 'effort:'] as const;

function isStatusLabel(label: string, labelPrefix: string): boolean {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  if (!label.startsWith(normalizedPrefix)) {
    return false;
  }
  const value = label.slice(normalizedPrefix.length);
  if (value.startsWith('status:')) {
    return true;
  }
  return value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted';
}

/**
 * Returns true when `label` is a worklog single-valued category label (e.g.
 * `wl:stage:idea`, `wl:priority:high`) or a bare legacy status label (e.g.
 * `wl:open`).
 *
 * Tags (`wl:tag:*`) are excluded because multiple tags are valid on a single
 * issue.
 */
export function isSingleValueCategoryLabel(label: string, labelPrefix: string): boolean {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  if (!label.startsWith(normalizedPrefix)) {
    return false;
  }
  const value = label.slice(normalizedPrefix.length);

  // Check known single-value categories
  for (const cat of SINGLE_VALUE_LABEL_CATEGORIES) {
    if (value.startsWith(cat)) {
      return true;
    }
  }

  // Legacy bare status values (e.g. wl:open, wl:in-progress)
  if (value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted') {
    return true;
  }

  return false;
}

function ensureGithubLabels(config: GithubConfig, labels: string[]): void {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) {
    return;
  }

  const { owner, name } = parseRepoSlug(config.repo);
  // Load existing labels once per process for this repo and reuse it.
  let existing = existingLabelsCache.get(config.repo);
  if (existing === undefined && !existingLabelsCache.has(config.repo)) {
    // Not fetched yet for this process - attempt to fetch and cache result.
    const existingRaw = runGhSafe(`gh api repos/${owner}/${name}/labels --paginate`);
    if (existingRaw) {
      const parsedSet = new Set<string>();
      try {
        const parsed = JSON.parse(existingRaw) as Array<{ name?: string }>;
        for (const entry of parsed) {
          if (entry.name) parsedSet.add(entry.name);
        }
      } catch {
        // If parsing fails, fall back to an empty set but mark as fetched so we don't refetch.
      }
      existingLabelsCache.set(config.repo, parsedSet);
      existing = parsedSet;
    } else {
      // Mark as fetched but empty to avoid repeated failing API calls.
      existingLabelsCache.set(config.repo, new Set<string>());
      existing = existingLabelsCache.get(config.repo)!;
    }
  }
  // Ensure we have a Set to consult
  if (!existing) existing = new Set<string>();

  for (const label of unique) {
    if (existing.has(label)) {
      continue;
    }
    const color = labelColor(label);
    const createCommand = `gh api -X POST repos/${owner}/${name}/labels -f name=${JSON.stringify(label)} -f color=${JSON.stringify(color)}`;
    const result = runGhSafe(createCommand);
    if (result !== null) {
      // Update cached set so subsequent calls in this process know the label exists.
      try { existing.add(label); } catch (_) {}
      continue;
    }
    const fallbackCommand = `gh issue label create ${JSON.stringify(label)} --repo ${config.repo} --color ${color}`;
    runGhSafe(fallbackCommand);
    try { existing.add(label); } catch (_) {}
  }
}

export function normalizeGithubLabelPrefix(prefix?: string): string {
  if (!prefix) return 'wl:';
  return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repo: ${repo}`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function getRepoFromGitRemote(): string | null {
  try {
    const output = runGh('gh repo view --json nameWithOwner');
    const parsed = JSON.parse(output) as { nameWithOwner?: string };
    return parsed.nameWithOwner || null;
  } catch {
    return null;
  }
}

export function buildWorklogMarker(workItemId: string): string {
  return `${WORKLOG_MARKER_PREFIX}${workItemId}${WORKLOG_MARKER_SUFFIX}`;
}

export function buildWorklogCommentMarker(commentId: string): string {
  return `${WORKLOG_COMMENT_MARKER_PREFIX}${commentId}${WORKLOG_COMMENT_MARKER_SUFFIX}`;
}

export function stripWorklogMarkers(body?: string | null): string {
  if (!body) {
    return '';
  }
  const lines = body.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith(WORKLOG_MARKER_PREFIX)) {
      return false;
    }
    if (trimmed.startsWith(WORKLOG_COMMENT_MARKER_PREFIX)) {
      return false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

export function extractWorklogId(body?: string | null): string | null {
  if (!body) return null;
  const start = body.indexOf(WORKLOG_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(WORKLOG_MARKER_SUFFIX, start + WORKLOG_MARKER_PREFIX.length);
  if (end === -1) return null;
  const id = body.slice(start + WORKLOG_MARKER_PREFIX.length, end).trim();
  return id || null;
}

export function extractWorklogCommentId(body?: string | null): string | null {
  if (!body) return null;
  const start = body.indexOf(WORKLOG_COMMENT_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf(WORKLOG_COMMENT_MARKER_SUFFIX, start + WORKLOG_COMMENT_MARKER_PREFIX.length);
  if (end === -1) return null;
  const id = body.slice(start + WORKLOG_COMMENT_MARKER_PREFIX.length, end).trim();
  return id || null;
}

export function extractParentId(body?: string | null): string | null {
  if (!body) return null;
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('Parent:')) {
      continue;
    }
    const match = line.match(/^Parent:\s*([^\s-]+(?:-[^\s-]+)*)/);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  }
  return null;
}

export function extractParentIssueNumber(body?: string | null): number | null {
  if (!body) return null;
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('Parent:')) {
      continue;
    }
    const match = line.match(/#(\d+)/);
    if (match && match[1]) {
      return Number(match[1]);
    }
    return null;
  }
  return null;
}

export interface IssueHierarchy {
  parentIssueNumber: number | null;
  childIssueNumbers: number[];
}

function getIssueNodeId(config: GithubConfig, issueNumber: number): string {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { id }
    }
  }`;
  const output = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query GitHub issue node ID');
  }
  const id = output.data?.data?.repository?.issue?.id;
  if (!id) {
    throw new Error(`Unable to resolve GitHub issue node ID for #${issueNumber}`);
  }
  return id;
}

export function getIssueHierarchy(config: GithubConfig, issueNumber: number): IssueHierarchy {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        parent { number }
        subIssues(first: 100) { nodes { number } }
      }
    }
  }`;
  const output = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query issue hierarchy');
  }
  const issue = output.data?.data?.repository?.issue;
  const parentIssueNumber = issue?.parent?.number ?? null;
  const childIssueNumbers = Array.isArray(issue?.subIssues?.nodes)
    ? issue.subIssues.nodes.map((node: any) => node?.number).filter((value: any) => typeof value === 'number')
    : [];
  return { parentIssueNumber, childIssueNumbers };
}

// Async wrappers -----------------------------------------------------------
export async function getIssueNodeIdAsync(config: GithubConfig, issueNumber: number): Promise<string> {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`;
  const output = await runGhJsonDetailedAsync(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query GitHub issue node ID');
  }
  const id = output.data?.data?.repository?.issue?.id;
  if (!id) {
    throw new Error(`Unable to resolve GitHub issue node ID for #${issueNumber}`);
  }
  return id;
}

export async function getIssueHierarchyAsync(config: GithubConfig, issueNumber: number): Promise<IssueHierarchy> {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { parent { number } subIssues(first: 100) { nodes { number } } } } }`;
  const output = await runGhJsonDetailedAsync(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query issue hierarchy');
  }
  const issue = output.data?.data?.repository?.issue;
  const parentIssueNumber = issue?.parent?.number ?? null;
  const childIssueNumbers = Array.isArray(issue?.subIssues?.nodes)
    ? issue.subIssues.nodes.map((node: any) => node?.number).filter((value: any) => typeof value === 'number')
    : [];
  return { parentIssueNumber, childIssueNumbers };
}

export function addSubIssueLink(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): void {
  const nodeCache = cache ?? new Map<number, string>();
  const resolveNodeId = (issueNumber: number) => {
    const cached = nodeCache.get(issueNumber);
    if (cached) {
      return cached;
    }
    const nodeId = getIssueNodeId(config, issueNumber);
    nodeCache.set(issueNumber, nodeId);
    return nodeId;
  };
  const parentNodeId = resolveNodeId(parentIssueNumber);
  const childNodeId = resolveNodeId(childIssueNumber);
  const mutation = `mutation($parent: ID!, $child: ID!) {
    addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } subIssue { id } }
  }`;
  const result = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(mutation)} -f parent=${quoteShellValue(parentNodeId)} -f child=${quoteShellValue(childNodeId)}`
  );
  if (!result.ok) {
    throw new Error(result.error || `Failed to link #${childIssueNumber} as sub-issue of #${parentIssueNumber}`);
  }
  const mutationResult = result.data?.data?.addSubIssue;
  if (!mutationResult?.subIssue?.id || !mutationResult?.issue?.id) {
    throw new Error('addSubIssue returned no data (sub-issues may be disabled for this repo/org)');
  }
}

export function addSubIssueLinkResult(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): { ok: boolean; error?: string } {
  try {
    addSubIssueLink(config, parentIssueNumber, childIssueNumber, cache);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function addSubIssueLinkAsync(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): Promise<void> {
  const nodeCache = cache ?? new Map<number, string>();
  const resolveNodeId = async (issueNumber: number) => {
    const cached = nodeCache.get(issueNumber);
    if (cached) return cached;
    const nodeId = await getIssueNodeIdAsync(config, issueNumber);
    nodeCache.set(issueNumber, nodeId);
    return nodeId;
  };
  const parentNodeId = await resolveNodeId(parentIssueNumber);
  const childNodeId = await resolveNodeId(childIssueNumber);
  const mutation = `mutation($parent: ID!, $child: ID!) { addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } subIssue { id } } }`;
  const result = await runGhJsonDetailedAsync(
    `gh api graphql -f query=${quoteShellValue(mutation)} -f parent=${quoteShellValue(parentNodeId)} -f child=${quoteShellValue(childNodeId)}`
  );
  if (!result.ok) {
    throw new Error(result.error || `Failed to link #${childIssueNumber} as sub-issue of #${parentIssueNumber}`);
  }
  const mutationResult = result.data?.data?.addSubIssue;
  if (!mutationResult?.subIssue?.id || !mutationResult?.issue?.id) {
    throw new Error('addSubIssue returned no data (sub-issues may be disabled for this repo/org)');
  }
}

export async function addSubIssueLinkResultAsync(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): Promise<{ ok: boolean; error?: string }> {
  try {
    await addSubIssueLinkAsync(config, parentIssueNumber, childIssueNumber, cache);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function listParentIssueNumbersFromTimeline(config: GithubConfig, issueNumber: number): number[] {
  const command = `gh api repos/${config.repo}/issues/${issueNumber}/timeline --paginate`;
  const output = runGhSafeJson(command);
  if (!Array.isArray(output)) {
    return [];
  }
  const parents: number[] = [];
  for (const event of output) {
    if (event?.event === 'added_to_parent' && typeof event?.parent_issue?.number === 'number') {
      parents.push(event.parent_issue.number);
    }
  }
  return parents;
}

export function extractChildIds(body?: string | null): string[] {
  if (!body) return [];
  const lines = body.split('\n');
  const childIds: string[] = [];
  let inChildren = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (inChildren) {
        break;
      }
      continue;
    }
    if (line.startsWith('Children:') || line.startsWith('Pending children:')) {
      inChildren = true;
      continue;
    }
    if (!inChildren) {
      continue;
    }
    if (!line.startsWith('- ')) {
      break;
    }
    const match = line.match(/^-\s*([^\s-]+(?:-[^\s-]+)*)/);
    if (match && match[1]) {
      childIds.push(match[1]);
    }
  }
  return childIds;
}

export function extractChildIssueNumbers(body?: string | null): number[] {
  if (!body) return [];
  const lines = body.split('\n');
  const childIssueNumbers: number[] = [];
  let inChildren = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (inChildren) {
        break;
      }
      continue;
    }
    if (line.startsWith('Sub-issues:') || line.startsWith('Children:')) {
      inChildren = true;
      continue;
    }
    if (!inChildren) {
      continue;
    }
    const match = line.match(/#(\d+)/);
    if (!match || !match[1]) {
      if (!line.startsWith('-')) {
        break;
      }
      continue;
    }
    childIssueNumbers.push(Number(match[1]));
  }
  return childIssueNumbers;
}

export function workItemToIssuePayload(
  item: WorkItem,
  comments: Comment[],
  labelPrefix: string,
  allItems?: WorkItem[]
): { title: string; body: string; labels: string[]; state: 'open' | 'closed' } {
  const marker = buildWorklogMarker(item.id);
  const summaryLines: string[] = [marker];
  if (allItems) {
    void allItems;
  }
  summaryLines.push('');
  if (item.description) {
    summaryLines.push(stripWorklogMarkers(item.description));
  }
  void comments;

  const labels = new Set<string>();
  labels.add(`${labelPrefix}status:${item.status}`);
  labels.add(`${labelPrefix}priority:${item.priority}`);
  if (item.stage) {
    labels.add(`${labelPrefix}stage:${item.stage}`);
  }
  if (item.issueType) {
    labels.add(`${labelPrefix}type:${item.issueType}`);
  }
  if (item.risk) {
    labels.add(`${labelPrefix}risk:${item.risk}`);
  }
  if (item.effort) {
    labels.add(`${labelPrefix}effort:${item.effort}`);
  }
  for (const tag of item.tags) {
    labels.add(`${labelPrefix}tag:${tag}`);
  }

  const state = item.status === 'completed' || item.status === 'deleted' ? 'closed' : 'open';
  return {
    title: item.title,
    body: summaryLines.join('\n'),
    labels: Array.from(labels),
    state,
  };
}

function normalizeGithubIssueComment(comment: any): GithubIssueComment {
  return {
    id: comment.id,
    body: comment.body ?? null,
    updatedAt: comment.updated_at || comment.updatedAt || new Date().toISOString(),
    author: comment.user?.login || comment.author?.login,
  };
}

export function listGithubIssueComments(config: GithubConfig, issueNumber: number): GithubIssueComment[] {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/${issueNumber}/comments --paginate`;
  const data = runGhSafeJson(command);
  if (!data) {
    return [];
  }
  const raw = Array.isArray(data) ? data : [];
  return raw.map(comment => normalizeGithubIssueComment(comment));
}

// Async variants -----------------------------------------------------------
export async function listGithubIssueCommentsAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueComment[]> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/${issueNumber}/comments --paginate`;
  try {
    const data = await runGhJsonAsync(command);
    if (!data) return [];
    const raw = Array.isArray(data) ? data : [];
    return raw.map(comment => normalizeGithubIssueComment(comment));
  } catch {
    return [];
  }
}

export function createGithubIssueComment(config: GithubConfig, issueNumber: number, body: string): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X POST repos/${owner}/${name}/issues/${issueNumber}/comments -f body=${JSON.stringify(body)}`;
  const data = runGhJson(command);
  return normalizeGithubIssueComment(data);
}

export async function createGithubIssueCommentAsync(config: GithubConfig, issueNumber: number, body: string): Promise<GithubIssueComment> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X POST repos/${owner}/${name}/issues/${issueNumber}/comments -f body=${JSON.stringify(body)}`;
  const data = await runGhJsonAsync(command);
  return normalizeGithubIssueComment(data);
}

export function updateGithubIssueComment(config: GithubConfig, commentId: number, body: string): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X PATCH repos/${owner}/${name}/issues/comments/${commentId} -f body=${JSON.stringify(body)}`;
  const data = runGhJson(command);
  return normalizeGithubIssueComment(data);
}

export async function updateGithubIssueCommentAsync(config: GithubConfig, commentId: number, body: string): Promise<GithubIssueComment> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X PATCH repos/${owner}/${name}/issues/comments/${commentId} -f body=${JSON.stringify(body)}`;
  const data = await runGhJsonAsync(command);
  return normalizeGithubIssueComment(data);
}

export function getGithubIssueComment(config: GithubConfig, commentId: number): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/comments/${commentId} --json id,body,updatedAt,user`;
  const data = runGhJson(command);
  return normalizeGithubIssueComment(data);
}

export async function getGithubIssueCommentAsync(config: GithubConfig, commentId: number): Promise<GithubIssueComment> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/comments/${commentId} --json id,body,updatedAt,user`;
  const data = await runGhJsonAsync(command);
  return normalizeGithubIssueComment(data);
}

/**
 * Legacy priority label mapping. Labels like `wl:P0`, `wl:P1`, etc. are mapped
 * to the current priority values for backward compatibility during import.
 */
const LEGACY_PRIORITY_MAP: Record<string, WorkItemPriority> = {
  P0: 'critical',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

export function issueToWorkItemFields(
  issue: GithubIssueRecord,
  labelPrefix: string
): { status: WorkItemStatus; priority: WorkItemPriority; tags: string[]; risk: string; effort: string; stage: string; issueType: string } {
  const normalizedPrefix = normalizeGithubLabelPrefix(labelPrefix);
  const tags: string[] = [];
  let status: WorkItemStatus = issue.state === 'closed' ? 'completed' : 'open';
  let priority: WorkItemPriority = 'medium';
  let risk = '';
  let effort = '';
  let stage = '';
  let issueType = '';

  for (const label of issue.labels) {
    if (label.startsWith(normalizedPrefix)) {
      const value = label.slice(normalizedPrefix.length);
      if (value.startsWith('status:')) {
        const nextStatus = value.slice('status:'.length);
        if (nextStatus === 'open' || nextStatus === 'in-progress' || nextStatus === 'completed' || nextStatus === 'blocked' || nextStatus === 'deleted') {
          status = nextStatus;
        }
        continue;
      }
      if (value === 'open' || value === 'in-progress' || value === 'completed' || value === 'blocked' || value === 'deleted') {
        status = value;
        continue;
      }
      if (value.startsWith('priority:')) {
        const prio = value.slice('priority:'.length);
        if (prio === 'low' || prio === 'medium' || prio === 'high' || prio === 'critical') {
          priority = prio;
        }
        continue;
      }
      // Legacy priority labels: wl:P0, wl:P1, wl:P2, wl:P3
      if (LEGACY_PRIORITY_MAP[value]) {
        priority = LEGACY_PRIORITY_MAP[value];
        continue;
      }
      if (value.startsWith('stage:')) {
        const stageValue = value.slice('stage:'.length);
        if (stageValue) {
          stage = stageValue;
        }
        continue;
      }
      if (value.startsWith('type:')) {
        const typeValue = value.slice('type:'.length);
        if (typeValue) {
          issueType = typeValue;
        }
        continue;
      }
      if (value.startsWith('risk:')) {
        const riskValue = value.slice('risk:'.length);
        if (riskValue === 'Low' || riskValue === 'Medium' || riskValue === 'High' || riskValue === 'Severe') {
          risk = riskValue;
        }
        continue;
      }
      if (value.startsWith('effort:')) {
        const effortValue = value.slice('effort:'.length);
        if (effortValue === 'XS' || effortValue === 'S' || effortValue === 'M' || effortValue === 'L' || effortValue === 'XL') {
          effort = effortValue;
        }
        continue;
      }
      if (value.startsWith('tag:')) {
        const tag = value.slice('tag:'.length);
        if (tag) {
          tags.push(tag);
        }
      }
      continue;
    }
    tags.push(label);
  }

  return { status, priority, tags: Array.from(new Set(tags)), risk, effort, stage, issueType };
}

export function createGithubIssue(config: GithubConfig, payload: { title: string; body: string; labels: string[] }): GithubIssueRecord {
  const command = `gh issue create --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
  const output = runGh(command, payload.body);
  let issueNumber: number | null = null;
  const match = output.match(/\/(\d+)$/);
  if (match) {
    issueNumber = parseInt(match[1], 10);
  }
  if (issueNumber !== null && payload.labels.length > 0) {
    // Ensure labels once per process to reduce API calls
    ensureGithubLabelsOnce(config, payload.labels);
    runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(payload.labels.join(','))}`);
  }
  if (issueNumber === null) {
    const view = runGh(`gh issue list --repo ${config.repo} --limit 1 --json number,id,title,body,state,labels,updatedAt`);
    const parsed = JSON.parse(view) as any[];
    if (parsed.length > 0) {
      return normalizeGithubIssue(parsed[0]);
    }
    throw new Error('Failed to create GitHub issue');
  }
  const view = runGh(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  const parsed = JSON.parse(view) as any;
  return normalizeGithubIssue(parsed);
}

export async function ensureGithubLabelsAsync(config: GithubConfig, labels: string[]): Promise<void> {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const { owner, name } = parseRepoSlug(config.repo);
  try {
    // Reuse per-process cache if available, otherwise fetch once and cache.
    let existing = existingLabelsCache.get(config.repo);
    if (existing === undefined && !existingLabelsCache.has(config.repo)) {
      try {
        const existingRaw = await runGhJsonAsync(`gh api repos/${owner}/${name}/labels --paginate`);
        const parsedSet = new Set<string>();
        if (existingRaw) {
          for (const entry of existingRaw) {
            if (entry?.name) parsedSet.add(entry.name);
          }
        }
        existingLabelsCache.set(config.repo, parsedSet);
        existing = parsedSet;
      } catch {
        // If fetch fails, cache an empty set to avoid repeated attempts.
        existingLabelsCache.set(config.repo, new Set<string>());
        existing = existingLabelsCache.get(config.repo)!;
      }
    }
    if (!existing) existing = new Set<string>();

    for (const label of unique) {
      if (existing.has(label)) continue;
      const color = labelColor(label);
      const createCommand = `gh api -X POST repos/${owner}/${name}/labels -f name=${JSON.stringify(label)} -f color=${JSON.stringify(color)}`;
      try {
        await runGhAsync(createCommand);
        existing.add(label);
        continue;
      } catch {
        const fallbackCommand = `gh issue label create ${JSON.stringify(label)} --repo ${config.repo} --color ${color}`;
        try { await runGhAsync(fallbackCommand); existing.add(label); } catch (_) { /* ignore */ }
      }
    }
  } catch {
    // ignore label creation failures
  }
}

// Per-process cache to avoid repeatedly ensuring the same labels for the same repo
const ensuredLabelsCache = new Map<string, Set<string>>();
// Cache of existing repo labels fetched from GitHub. Keyed by repo (owner/name).
// When populated it avoids calling the labels API repeatedly during a single process run.
const existingLabelsCache: Map<string, Set<string> | undefined> = new Map();

function ensureGithubLabelsOnce(config: GithubConfig, labels: string[]): void {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const cacheKey = config.repo;
  let cache = ensuredLabelsCache.get(cacheKey);
  if (!cache) {
    cache = new Set<string>();
    ensuredLabelsCache.set(cacheKey, cache);
  }
  const missing = unique.filter(l => !cache!.has(l));
  if (missing.length === 0) return;
  ensureGithubLabels(config, missing);
  for (const l of missing) cache.add(l);
}

async function ensureGithubLabelsOnceAsync(config: GithubConfig, labels: string[]): Promise<void> {
  const unique = Array.from(new Set(labels.filter(label => label.trim() !== '')));
  if (unique.length === 0) return;
  const cacheKey = config.repo;
  let cache = ensuredLabelsCache.get(cacheKey);
  if (!cache) {
    cache = new Set<string>();
    ensuredLabelsCache.set(cacheKey, cache);
  }
  const missing = unique.filter(l => !cache!.has(l));
  if (missing.length === 0) return;
  await ensureGithubLabelsAsync(config, missing);
  for (const l of missing) cache.add(l);
}

export async function createGithubIssueAsync(config: GithubConfig, payload: { title: string; body: string; labels: string[] }): Promise<GithubIssueRecord> {
  const command = `gh issue create --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
  const output = await runGhAsync(command, payload.body);
  let issueNumber: number | null = null;
  const match = output.match(/\/(\d+)$/);
  if (match) issueNumber = parseInt(match[1], 10);
  if (issueNumber !== null && payload.labels.length > 0) {
    // Ensure labels once per process to reduce API calls
    await ensureGithubLabelsOnceAsync(config, payload.labels);
    try { await runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(payload.labels.join(','))}`); } catch (_) {}
  }
  if (issueNumber === null) {
    const view = await runGhJsonAsync(`gh issue list --repo ${config.repo} --limit 1 --json number,id,title,body,state,labels,updatedAt`);
    if (Array.isArray(view) && view.length > 0) return normalizeGithubIssue(view[0]);
    throw new Error('Failed to create GitHub issue');
  }
  const parsed = await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  return normalizeGithubIssue(parsed);
}

export async function updateGithubIssueAsync(
  config: GithubConfig,
  issueNumber: number,
  payload: { title: string; body: string; labels: string[]; state: 'open' | 'closed' }
): Promise<GithubIssueRecord> {
  // Fetch current issue once and compute minimal set of operations
  let current: GithubIssueRecord;
  try {
    current = await getGithubIssueAsync(config, issueNumber);
  } catch {
    current = getGithubIssue(config, issueNumber);
  }

  const ops: Array<Promise<void>> = [];
  const titleChanged = (current.title || '') !== (payload.title || '');
  const bodyChanged = (current.body || '') !== (payload.body || '');
  // Only edit title/body if something changed
  if (titleChanged || bodyChanged) {
    const command = `gh issue edit ${issueNumber} --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`;
    ops.push(runGhAsync(command, payload.body).then(() => {}).catch(() => {}));
  }

  // State change: only close/reopen when different
  if (payload.state === 'closed' && current.state !== 'closed') {
    ops.push(runGhAsync(`gh issue close ${issueNumber} --repo ${config.repo}`).then(() => {}).catch(() => {}));
  } else if (payload.state === 'open' && current.state === 'closed') {
    ops.push(runGhAsync(`gh issue reopen ${issueNumber} --repo ${config.repo}`).then(() => {}).catch(() => {}));
  }

  // Labels: compute status labels to remove and labels to add
  if (payload.labels.length > 0) {
    const desiredSet = new Set(payload.labels);
    // Remove any single-valued category labels (stage, priority, status, type,
    // risk, effort) that are on the issue but not in the desired set. This
    // prevents label accumulation when e.g. stage changes from idea -> done.
    const staleLabelsToRemove = current.labels.filter(label => isSingleValueCategoryLabel(label, config.labelPrefix) && !desiredSet.has(label));
    if (staleLabelsToRemove.length > 0) {
      ops.push(runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --remove-label ${JSON.stringify(staleLabelsToRemove.join(','))}`).then(() => {}).catch(() => {}));
    }

    // Compute labels that are not already present
    const labelsToAdd = payload.labels.filter(l => !current.labels.includes(l));
    if (labelsToAdd.length > 0) {
      await ensureGithubLabelsOnceAsync(config, labelsToAdd);
      ops.push(runGhAsync(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(labelsToAdd.join(','))}`).then(() => {}).catch(() => {}));
    }
  }

  // Execute operations — remove stale labels first, then add new ones,
  // to avoid transient states where both old and new labels coexist.
  if (ops.length > 0) await Promise.all(ops);

  // If no ops ran, return current object, else fetch fresh state
  if (ops.length === 0) return current;
  const parsed = await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  return normalizeGithubIssue(parsed);
}

export async function getGithubIssueAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueRecord> {
  const parsed = await runGhJsonAsync(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  return normalizeGithubIssue(parsed);
}

export async function listGithubIssuesAsync(config: GithubConfig, since?: string): Promise<GithubIssueRecord[]> {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const apiPath = `repos/${config.repo}/issues?state=all&per_page=100${sinceParam}`;
  const apiCommand = `gh api ${quoteShellValue(apiPath)} --paginate`;
  const output = await runGhAsync(apiCommand);
  const parsed = JSON.parse(output) as any[];
  const issuesOnly = parsed.filter(entry => {
    if (entry.pull_request) return false;
    if (typeof entry.html_url === 'string' && entry.html_url.includes('/pull/')) return false;
    if (typeof entry.pull_request_url === 'string' && entry.pull_request_url.length > 0) return false;
    return true;
  });
  return issuesOnly.map(entry => normalizeGithubIssue({
    id: entry.id,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    labels: entry.labels || [],
    updatedAt: entry.updated_at,
    subIssuesSummary: entry.sub_issues_summary ? { total: entry.sub_issues_summary.total ?? 0, completed: entry.sub_issues_summary.completed ?? 0 } : undefined,
  }));
}

export function updateGithubIssue(
  config: GithubConfig,
  issueNumber: number,
  payload: { title: string; body: string; labels: string[]; state: 'open' | 'closed' }
): GithubIssueRecord {
  // Fetch current issue once and compute minimal operations
  const current = getGithubIssue(config, issueNumber);
  const ops: (() => void)[] = [];
  const titleChanged = (current.title || '') !== (payload.title || '');
  const bodyChanged = (current.body || '') !== (payload.body || '');
  if (titleChanged || bodyChanged) {
    ops.push(() => runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --title ${JSON.stringify(payload.title)} --body-file -`, payload.body));
  }

  if (payload.state === 'closed' && current.state !== 'closed') {
    ops.push(() => runGh(`gh issue close ${issueNumber} --repo ${config.repo}`));
  } else if (payload.state === 'open' && current.state === 'closed') {
    ops.push(() => runGh(`gh issue reopen ${issueNumber} --repo ${config.repo}`));
  }

  if (payload.labels.length > 0) {
    const desiredSet = new Set(payload.labels);
    const staleLabelsToRemove = current.labels.filter(label => isSingleValueCategoryLabel(label, config.labelPrefix) && !desiredSet.has(label));
    if (staleLabelsToRemove.length > 0) {
      ops.push(() => runGhSafe(`gh issue edit ${issueNumber} --repo ${config.repo} --remove-label ${JSON.stringify(staleLabelsToRemove.join(','))}`));
    }

    const labelsToAdd = payload.labels.filter(l => !current.labels.includes(l));
    if (labelsToAdd.length > 0) {
      ensureGithubLabelsOnce(config, labelsToAdd);
      ops.push(() => runGh(`gh issue edit ${issueNumber} --repo ${config.repo} --add-label ${JSON.stringify(labelsToAdd.join(','))}`));
    }
  }

  for (const op of ops) {
    try { op(); } catch (_) { /* ignore individual failures */ }
  }

  if (ops.length === 0) return current;
  const output = runGh(`gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`);
  const parsed = JSON.parse(output) as any;
  return normalizeGithubIssue(parsed);
}

export function listGithubIssues(config: GithubConfig, since?: string): GithubIssueRecord[] {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : '';
  const apiPath = `repos/${config.repo}/issues?state=all&per_page=100${sinceParam}`;
  const apiCommand = `gh api ${quoteShellValue(apiPath)} --paginate`;
  const output = runGh(apiCommand);
  const parsed = JSON.parse(output) as any[];
  const issuesOnly = parsed.filter(entry => {
    if (entry.pull_request) {
      return false;
    }
    if (typeof entry.html_url === 'string' && entry.html_url.includes('/pull/')) {
      return false;
    }
    if (typeof entry.pull_request_url === 'string' && entry.pull_request_url.length > 0) {
      return false;
    }
    return true;
  });
  return issuesOnly.map(entry =>
    normalizeGithubIssue({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      body: entry.body,
      state: entry.state,
      labels: entry.labels || [],
      updatedAt: entry.updated_at,
      subIssuesSummary: entry.sub_issues_summary
        ? {
            total: entry.sub_issues_summary.total ?? 0,
            completed: entry.sub_issues_summary.completed ?? 0,
          }
        : undefined,
    })
  );
}

export function getGithubIssue(config: GithubConfig, issueNumber: number): GithubIssueRecord {
  const command = `gh issue view ${issueNumber} --repo ${config.repo} --json number,id,title,body,state,labels,updatedAt`;
  const output = runGh(command);
  const parsed = JSON.parse(output) as any;
  return normalizeGithubIssue(parsed);
}

function normalizeGithubIssue(raw: any): GithubIssueRecord {
  const stateRaw = typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? null,
    state: stateRaw === 'closed' ? 'closed' : 'open',
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => l.name || l) : [],
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    subIssuesSummary: raw.subIssuesSummary,
  };
}
