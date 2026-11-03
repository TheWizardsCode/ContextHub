/**
 * src/github/transport.ts — `gh` CLI transport for the GitHub integration.
 *
 * Concern: everything that talks to the `gh` binary — subprocess execution
 * (`runGh`, `runGhDetailed`, `runGhAsync`, `runGhDetailedAsync`, `spawnCommand`),
 * retry/backoff for rate limits, the throttler-scheduled `ghApi*Scheduled`
 * wrappers, secondary-rate-limit detection (`isSecondaryRateLimitText`,
 * `SecondaryRateLimitError`), the verbose logger
 * (`setVerboseLogger`/`logVerbose`) and shell quoting (`quoteShellValue`,
 * re-exported from `src/shell-escape.ts` so the codebase keeps exactly one
 * definition).
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXWRQ000IFET, child 2 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Behaviour is unchanged:
 * no signature, default, retry-count, backoff or logging change. Only the six
 * symbols that are public today (`setVerboseLogger`, `isSecondaryRateLimitText`,
 * `SecondaryRateLimitError`, `ghApiAsyncScheduled`, `ghApiDetailedScheduled`,
 * `ghApiJsonScheduled`) are re-exported by the `src/github.ts` barrel; the
 * remaining helpers are exported here for internal use by sibling modules and
 * are NOT part of the public surface.
 *
 * This module depends on the throttler and the shared shell-escaping utility
 * only — never on the `src/github.ts` barrel — so the family's import graph
 * stays acyclic.
 */

import { execSync, spawnSync, spawn } from 'child_process';
import throttler from '../github-throttler.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export { quoteShellValue } from '../shell-escape.js';

// Verbose logger for GH calls; set by CLI when --verbose is used.
let _verboseLogger: ((msg: string) => void) | null = null;
export function setVerboseLogger(logger: ((msg: string) => void) | null) {
  _verboseLogger = logger;
}
function logVerbose(msg: string) {
  try {
    if (_verboseLogger) _verboseLogger(msg);
  } catch (_) {}
}

export function runGh(command: string, input?: string): string {
  // For potentially large paginated outputs, stream stdout to a temp file using spawnSync
  // to avoid spawnSync/execSync ENOBUFS or buffer limitations in Node.
  if (command.includes('--paginate')) {
    const outPath = path.join(os.tmpdir(), `worklog-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const errPath = `${outPath}.err`;
    // Open file descriptors for stdout/stderr
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    try {
      logVerbose(`runGh (sync paginate): ${command} -> ${outPath}`);
      const start = Date.now();
      const res = spawnSync('/bin/bash', ['-c', command], {
        encoding: 'utf-8',
        stdio: ['pipe', outFd, errFd],
        input,
      });
      const stdout = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8').trim() : '';
      const stderr = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf-8').trim() : '';
      logVerbose(`runGh (sync paginate) completed in ${Date.now() - start}ms status=${res?.status}`);
      if (res.error) {
        const e = res.error as Error;
        e.message = `${e.message}\n${stderr}`;
        logVerbose(`runGh (sync paginate) error: ${stderr}`);
        throw e;
      }
      if (res.status !== 0) {
        logVerbose(`runGh (sync paginate) non-zero exit: ${res.status} stderr=${stderr}`);
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

  // Synchronous runner with retry/backoff support for secondary limits.
  const { maxRetries } = getBackoffConfig();
  let attempt = 0;
  while (true) {
    try {
      logVerbose(`runGh (sync): ${command}`);
      const start = Date.now();
      const out = execSync(command, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        input,
        shell: '/bin/bash',
      }).toString().trim();
      logVerbose(`runGh (sync) completed in ${Date.now() - start}ms`);
      return out;
    } catch (err: any) {
      const stderr = (err?.stderr ? String(err.stderr) : '') || err?.message || '';
      const stdout = (err?.stdout ? String(err.stdout) : '') || '';
      logVerbose(`runGh (sync) error: ${stderr || stdout}`);
      // If this is clearly the secondary-rate-limit / abuse response, abort
      if (isSecondaryRateLimitText(stderr) || isSecondaryRateLimitText(stdout)) {
        throw new SecondaryRateLimitError('secondary rate limit detected (sync)', { stdout, stderr });
      }
      if (attempt < maxRetries && /403|rate limit/i.test(stderr + stdout)) {
        const waitMs = computeFullJitterDelay(attempt);
        try { throttler.incrementRetry && throttler.incrementRetry(); } catch (_) {}
        logVerbose(`gh rate-limited (sync), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
        // Blocking sleep for sync path
        try {
          const sab = new SharedArrayBuffer(4);
          const ia = new Int32Array(sab);
          Atomics.wait(ia, 0, 0, waitMs);
        } catch (_) {
          const start = Date.now();
          while (Date.now() - start < waitMs) { /* busy wait */ }
        }
        attempt += 1;
        continue;
      }
      const e = err as Error;
      if (stderr) e.message = `${e.message}\n${stderr}`;
      try { throttler.incrementError && throttler.incrementError(); } catch (_) {}
      throw e;
    }
  }
}

export function runGhDetailed(command: string, input?: string): { ok: boolean; stdout: string; stderr: string } {
  // Use streaming approach for paginate commands to avoid buffer limits
  if (command.includes('--paginate')) {
    const outPath = path.join(os.tmpdir(), `worklog-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const errPath = `${outPath}.err`;
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    try {
      const res = spawnSync('/bin/bash', ['-c', command], {
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
    const child = spawn('/bin/bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (err: any) => {
      // Child processes can close stdin early; ignore async EPIPE to avoid unhandled exceptions.
      if (err?.code !== 'EPIPE' && err?.message) {
        stderr += `${stderr ? '\n' : ''}${err.message}`;
      }
    });
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

export async function runGhAsync(command: string, input?: string): Promise<string> {
  // For paginate commands prefer streaming via spawnCommand
  const { maxRetries } = getBackoffConfig();
  let attempt = 0;
  while (true) {
    const res = await spawnCommand(command, input);
    if (!res.error && res.code === 0) return res.stdout.trim();
    const stderr = res.stderr || '';
    const stdout = res.stdout || '';
    // If this looks like a secondary limit/abuse/403, throw immediately for a
    // distinct error so higher-level controllers can abort the overall sync.
    if (isSecondaryRateLimitText(stderr) || isSecondaryRateLimitText(stdout)) {
      throw new SecondaryRateLimitError('secondary rate limit detected (async spawn)', { stdout, stderr });
    }
    // Otherwise, if we matched a 403/rate-limit hint and have retries left,
    // apply backoff with jitter and retry.
    if (attempt < maxRetries && /403|rate limit/i.test(stderr + stdout)) {
      const waitMs = computeFullJitterDelay(attempt);
      try { throttler.incrementRetry && throttler.incrementRetry(); } catch (_) {}
      try { logVerbose(`gh rate-limited (async spawn), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`); } catch (_) {}
      await new Promise(r => setTimeout(r, waitMs));
      attempt += 1;
      continue;
    }
    if (res.error) {
      try { throttler.incrementError && throttler.incrementError(); } catch (_) {}
      throw res.error;
    }
    try { throttler.incrementError && throttler.incrementError(); } catch (_) {}
    throw new Error(res.stderr || `gh command failed with exit code ${res.code}`);
  }
}

export async function runGhDetailedAsync(command: string, input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await spawnCommand(command, input);
  if (res.code !== 0) {
    // If this looks like secondary-rate-limit/abuse detection, propagate
    // a dedicated error so callers can choose to abort the run immediately.
    if (isSecondaryRateLimitText(res.stderr) || isSecondaryRateLimitText(res.stdout)) {
      throw new SecondaryRateLimitError('secondary rate limit detected (detailed async)', { stdout: res.stdout, stderr: res.stderr });
    }
    return { ok: false, stdout: res.stdout, stderr: res.stderr || `gh command failed with exit code ${res.code}` };
  }
  return { ok: true, stdout: res.stdout, stderr: res.stderr };
}

// JSON helpers with simple retry/backoff for rate limits
export async function runGhJsonDetailedAsync(command: string, input?: string, retries = 3): Promise<{ ok: boolean; data?: any; error?: string }> {
  // Exponential backoff with full jitter on rate-limit/403/abuse responses.
  const maxRetries = Math.max(0, retries);
  let attempt = 0;
  const baseDelay = Number(process.env.WL_GH_BACKOFF_BASE_MS || '1000');
  const capDelay = Number(process.env.WL_GH_BACKOFF_MAX_MS || '8000');

  const isSecondaryLimit = (text: string | undefined) => {
    if (!text) return false;
    return /secondary rate limit|abuse detection|triggered an abuse|rate limit|403|API rate limit exceeded/i.test(text);
  };

  const computeDelay = (attemptNum: number) => {
    const raw = Math.min(capDelay, baseDelay * (2 ** attemptNum));
    return Math.floor(Math.random() * raw); // full jitter
  };

  while (attempt <= maxRetries) {
    const res = await runGhDetailedAsync(command, input);
    if (!res.ok) {
      const stderr = res.stderr || '';
      const stdout = res.stdout || '';
      // If this looks like a secondary-rate-limit / abuse / 403, propagate
      // a specialized error so callers can abort the overall sync/run.
      if (isSecondaryLimit(stderr) || isSecondaryLimit(stdout)) {
        throw new SecondaryRateLimitError('secondary rate limit detected (json detailed async)', { stdout, stderr });
      }
      // Otherwise, if we have retries left, backoff and retry.
      if (attempt < maxRetries) {
        const waitMs = computeDelay(attempt);
        try { throttler.incrementRetry && throttler.incrementRetry(); } catch (_) {}
        try { logVerbose(`gh rate-limited/restricted, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`); } catch (_) {}
        await new Promise(r => setTimeout(r, waitMs));
        attempt += 1;
        continue;
      }
      try { throttler.incrementError && throttler.incrementError(); } catch (_) {}
      return { ok: false, error: stderr || res.stdout || 'GraphQL request failed' };
    }
    try {
      const data = JSON.parse(res.stdout);
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        const message = data.errors.map((entry: any) => entry?.message || String(entry)).join('; ');
        return { ok: false, error: message || 'GraphQL request returned errors' };
      }
      return { ok: true, data };
    } catch {
      return { ok: false, error: 'Invalid JSON response from GraphQL' };
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

export async function runGhJsonAsync(command: string, input?: string): Promise<any> {
  // Use the detailed async JSON helper which includes retry/backoff behaviour.
  const detailed = await runGhJsonDetailedAsync(command, input);
  if (!detailed.ok) throw new Error(detailed.error || 'gh command failed');
  return detailed.data;
}

export async function ghApiAsyncScheduled(command: string, input?: string): Promise<string> {
  return await throttler.schedule(async () => {
    return await runGhAsync(command, input);
  });
}

export async function ghApiDetailedScheduled(command: string, input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await throttler.schedule(async () => {
    return await runGhDetailedAsync(command, input);
  });
}

export async function ghApiJsonScheduled(command: string, input?: string): Promise<any> {
  return await throttler.schedule(async () => {
    return await runGhJsonAsync(command, input);
  });
}

/**
 * Schedule a *detailed* JSON call (the `{ ok, data, error }` shape) through the
 * central throttler, so a caller that must inspect the failure instead of
 * throwing still honours concurrency and rate limits (WL-0MVVLXYRO006WP2I).
 *
 * Sibling of `ghApiJsonScheduled`, which unwraps to plain data and throws on
 * failure; this variant keeps `runGhJsonDetailedAsync`'s result contract.
 */
export async function ghApiJsonDetailedScheduled(
  command: string,
  input?: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
  return await throttler.schedule(async () => {
    return await runGhJsonDetailedAsync(command, input);
  });
}

export function runGhSafe(command: string, input?: string): string | null {
  try {
    return runGh(command, input);
  } catch {
    return null;
  }
}

export function runGhJson(command: string, input?: string): any {
  const output = runGh(command, input);
  return JSON.parse(output);
}

export function isSecondaryRateLimitText(text?: string): boolean {
  if (!text) return false;
  return /secondary rate limit|abuse detection|triggered an abuse|you have exceeded a secondary rate limit/i.test((text || '').toLowerCase());
}

export class SecondaryRateLimitError extends Error {
  public stdout?: string;
  public stderr?: string;
  constructor(message?: string, details?: { stdout?: string; stderr?: string }) {
    super(message || 'secondary rate limit');
    this.name = 'SecondaryRateLimitError';
    this.stdout = details?.stdout;
    this.stderr = details?.stderr;
  }
}

function getBackoffConfig() {
  const baseDelay = Number(process.env.WL_GH_BACKOFF_BASE_MS || '1000');
  const capDelay = Number(process.env.WL_GH_BACKOFF_MAX_MS || '8000');
  const maxRetries = Number(process.env.WL_GH_BACKOFF_MAX_RETRIES || '3');
  return { baseDelay, capDelay, maxRetries };
}

function computeFullJitterDelay(attempt: number) {
  const { baseDelay, capDelay } = getBackoffConfig();
  const raw = Math.min(capDelay, baseDelay * (2 ** attempt));
  return Math.floor(Math.random() * raw);
}

// Sync wrapper with retry/backoff for callers that need synchronous semantics.
function runGhJsonWithRetries(command: string, input?: string, retries = 3): any {
  const res = runGhJsonDetailed(command, input);
  if (!res.ok) throw new Error(res.error || 'gh command failed');
  return res.data;
}

export function runGhSafeJson(command: string, input?: string): any | null {
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

export function runGhJsonDetailed(command: string, input?: string, retries = 3): { ok: boolean; data?: any; error?: string } {
  // Synchronous detailed JSON runner with retry/backoff support.
  const maxRetries = Math.max(0, retries);
  const baseDelay = Number(process.env.WL_GH_BACKOFF_BASE_MS || '1000');
  const capDelay = Number(process.env.WL_GH_BACKOFF_MAX_MS || '8000');

  const isSecondaryLimit = (text: string | undefined) => {
    if (!text) return false;
    return /secondary rate limit|abuse detection|triggered an abuse|rate limit|403|API rate limit exceeded/i.test(text);
  };

  const computeDelay = (attemptNum: number) => {
    const raw = Math.min(capDelay, baseDelay * (2 ** attemptNum));
    return Math.floor(Math.random() * raw);
  };

  let attempt = 0;
  while (attempt <= maxRetries) {
    const result = runGhDetailed(command, input);
    if (!result.ok) {
      const stderr = result.stderr || '';
      const stdout = result.stdout || '';
      // If this looks like secondary-rate-limit / abuse, throw a specialized
      // error so higher-level code can abort the overall sync immediately.
      if (isSecondaryLimit(stderr) || isSecondaryLimit(stdout)) {
        throw new SecondaryRateLimitError('secondary rate limit detected (json detailed sync)', { stdout, stderr });
      }
      // Otherwise, if retries remain, sleep and retry.
      if (attempt < maxRetries) {
        const waitMs = computeDelay(attempt);
        try { throttler.incrementRetry && throttler.incrementRetry(); } catch (_) {}
        try { // synchronous sleep using Atomics.wait
          const sab = new SharedArrayBuffer(4);
          const ia = new Int32Array(sab);
          Atomics.wait(ia, 0, 0, waitMs);
        } catch (_) {
          // fallback to blocking via new Date loop if Atomics.wait not available
          const start = Date.now();
          while (Date.now() - start < waitMs) { /* busy wait */ }
        }
        attempt += 1;
        continue;
      }
      const error = result.stderr || result.stdout || 'GraphQL request failed';
      try { throttler.incrementError && throttler.incrementError(); } catch (_) {}
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
  return { ok: false, error: 'Max retries exceeded' };
}
