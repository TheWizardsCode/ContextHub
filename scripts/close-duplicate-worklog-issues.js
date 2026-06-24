#!/usr/bin/env node
// Close duplicate GitHub issues that share a worklog marker, keeping a single canonical issue per marker.
// Behavior per user instructions:
// - Choice: remove worklog marker from duplicates and close them.
// - Canonical selection: most recently updated issue (newest updated_at)
// - Do not merge content, do not add comments.
// - Print a report to console.

import { execFileSync } from 'child_process';
import fs from 'fs';

function runGh(args, input) {
  try {
    const opts = { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 };
    if (input) opts.input = input;
    return execFileSync('gh', args, opts).toString();
  } catch (err) {
    throw new Error(`gh command failed: gh ${args.join(' ')} -> ${err.message}`);
  }
}

function detectRepoFromGitRemote() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).toString().trim();
    // possible forms:
    // git@github.com:OWNER/REPO.git
    // https://github.com/OWNER/REPO.git
    // https://github.com/OWNER/REPO
    const m = url.match(/github\.com[:\/](.+?\/.+?)(?:\.git)?$/i);
    if (!m) throw new Error('Unable to parse origin remote URL for owner/repo');
    const ownerRepo = m[1];
    return ownerRepo;
  } catch (err) {
    throw new Error('Failed to determine repository from git remote origin: ' + err.message);
  }
}

function extractMarkers(body) {
  if (!body) return [];
  const re = /<!--\s*worklog:id=([^\s>]+)\s*-->/g;
  const matches = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    matches.push({ full: m[0], id: m[1] });
  }
  return matches;
}

function removeMarkerFromBody(body, markerId) {
  const b = body || '';
  // remove any <!-- worklog:id=MARKER --> occurrences (allow extra spaces)
  const esc = markerId.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp('<!--\\s*worklog:id=' + esc + '\\s*-->', 'g');
  return b.replace(re, '').trim();
}

async function main() {
  try {
    const repo = detectRepoFromGitRemote();
    console.log('Repository detected:', repo);

    console.log('Fetching all issues (state=all) via gh api...');
    const out = runGh(['api', `repos/${repo}/issues?state=all`, '--paginate']);
    let issues;
    try { issues = JSON.parse(out); } catch (e) { throw new Error('Failed to parse gh api output: ' + e.message); }

    console.log('Total issues fetched:', issues.length);

    const markerMap = new Map();
    for (const issue of issues) {
      const body = issue.body || '';
      const markers = extractMarkers(body);
      for (const mk of markers) {
        const arr = markerMap.get(mk.id) || [];
        arr.push({ issue, markerFull: mk.full });
        markerMap.set(mk.id, arr);
      }
    }

    const duplicates = [];
    for (const [marker, arr] of markerMap.entries()) {
      if (arr.length > 1) duplicates.push({ marker, issues: arr });
    }

    if (duplicates.length === 0) {
      console.log('No duplicate worklog markers found. Nothing to do.');
      return;
    }

    console.log(`Found ${duplicates.length} markers with duplicates. Proceeding to close duplicates per instructions.`);

    const report = [];

    for (const dup of duplicates) {
      // choose canonical = most recently updated issue
      const sorted = dup.issues.slice().sort((a,b) => new Date(b.issue.updated_at).getTime() - new Date(a.issue.updated_at).getTime());
      const canonical = sorted[0];
      const duplicatesToClose = sorted.slice(1);

      const entry = {
        marker: dup.marker,
        canonical: { number: canonical.issue.number, url: canonical.issue.html_url, updated_at: canonical.issue.updated_at },
        closed: [],
      };

      for (const candidate of duplicatesToClose) {
        const issueNumber = candidate.issue.number;
        const oldBody = candidate.issue.body || '';
        const newBody = removeMarkerFromBody(oldBody, dup.marker);
        // perform single PATCH: update body (if changed) and close
        const args = ['api', '-X', 'PATCH', `repos/${repo}/issues/${issueNumber}`];
        if (newBody !== oldBody) {
          args.push('-f', `body=${newBody}`);
        }
        args.push('-f', 'state=closed');
        try {
          runGh(args);
          entry.closed.push({ number: issueNumber, url: candidate.issue.html_url, bodyChanged: newBody !== oldBody });
          console.log(`Closed #${issueNumber} (marker ${dup.marker})${newBody!==oldBody? ' and removed marker':''}`);
        } catch (err) {
          console.error(`Failed to close #${issueNumber}: ${err.message}`);
          entry.closed.push({ number: issueNumber, url: candidate.issue.html_url, bodyChanged: newBody !== oldBody, error: err.message });
        }
      }

      report.push(entry);
    }

    console.log('\n=== Duplicate cleanup report ===');
    console.log(JSON.stringify({ repository: repo, timestamp: new Date().toISOString(), results: report }, null, 2));
    console.log('=== End report ===\n');

    console.log('Done. Please re-run `wl github import` to pick up the canonical mappings.');
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
}

main();