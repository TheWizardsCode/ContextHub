#!/usr/bin/env node
// Retry-close specific GitHub issues: remove worklog marker and close issue
// Usage: node scripts/retry-close-issues.cjs 90 51 28 112 ...
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function runGh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  } catch (err) {
    const e = err || {};
    const msg = e.message || String(e);
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    throw new Error(`gh ${args.join(' ')} failed: ${msg}\nstdout:${stdout}\nstderr:${stderr}`);
  }
}

function detectRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).toString().trim();
    const m = url.match(/github\.com[:\/](.+?\/.+?)(?:\.git)?$/i);
    if (!m) throw new Error('unable to parse origin remote URL');
    return m[1];
  } catch (err) {
    throw new Error('Failed to determine repo: ' + (err.message || err));
  }
}

function extractMarkers(body) {
  if (!body) return [];
  const re = /<!--\s*worklog:id=([^\s>]+)\s*-->/g;
  const out = [];
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

function removeMarker(body, marker) {
  if (!body) return body || '';
  const esc = marker.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp('<!--\\s*worklog:id=' + esc + '\\s*-->', 'g');
  return body.replace(re, '').trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function patchAndClose(repo, issueNumber) {
  // Fetch issue
  let res;
  try {
    res = runGh(['api', `repos/${repo}/issues/${issueNumber}`]);
  } catch (err) {
    return { ok: false, error: 'fetch_failed: ' + err.message };
  }
  let issue;
  try { issue = JSON.parse(res); } catch (err) { return { ok: false, error: 'parse_failed: ' + (err.message || err) }; }
  const body = issue.body || '';
  const markers = extractMarkers(body);
  // If no marker for this issue, still attempt to close
  const newBody = markers.length > 0 ? removeMarker(body, markers[0]) : body;

  // write body to temp file
  const tmp = path.join(os.tmpdir(), `wl-close-${issueNumber}-${Date.now()}.body`);
  fs.writeFileSync(tmp, newBody, 'utf8');

  const maxAttempts = 5;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      // Use -F body=@file to pass via file; set state=closed
      runGh(['api', '-X', 'PATCH', `repos/${repo}/issues/${issueNumber}`, '-F', `body=@${tmp}`, '-F', 'state=closed']);
      fs.unlinkSync(tmp);
      return { ok: true, attempt };
    } catch (err) {
      const msg = (err && err.message) ? String(err.message) : String(err);
      // On certain transient network errors, retry with backoff
      if (attempt < maxAttempts) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { ok: false, attempt, error: msg };
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/retry-close-issues.cjs <issue-number> [more numbers]');
    process.exit(1);
  }
  let repo;
  try { repo = detectRepo(); } catch (err) { console.error(err.message); process.exit(1); }
  const report = [];
  for (const a of args) {
    const num = Number(a);
    if (!Number.isInteger(num)) { report.push({ number: a, ok: false, error: 'invalid number' }); continue; }
    process.stdout.write(`Processing #${num} ... `);
    const r = await patchAndClose(repo, num);
    if (r.ok) { console.log(`OK (attempts=${r.attempt})`); report.push({ number: num, ok: true, attempts: r.attempt }); }
    else { console.log(`FAILED after ${r.attempt || 0} attempts: ${r.error}`); report.push({ number: num, ok: false, attempts: r.attempt || 0, error: r.error }); }
  }
  console.log('\nRetry report:');
  console.log(JSON.stringify({ repository: repo, timestamp: new Date().toISOString(), results: report }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
