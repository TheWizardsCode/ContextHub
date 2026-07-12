#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  beads-issues-to-worklog-jsonl.sh <issues.jsonl> [worklog-data.jsonl]

Converts a Beads issues.jsonl file to Worklog's worklog-data.jsonl format.
Writes both work items and comment records.

If worklog-data.jsonl is omitted, defaults to:
  .worklog/worklog-data.jsonl

Notes:
- Beads timestamps with nanoseconds and offsets are normalized to ISO Z.
- Beads status mapping:
    open -> open
    in_progress -> in-progress
    closed -> completed
    tombstone -> deleted
- Beads priority mapping (0 highest, 4 lowest):
    0 -> critical
    1 -> high
    2 -> medium
    3 -> low
    4 -> low
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 2
fi

in_path=$1
out_path=${2:-.worklog/worklog-data.jsonl}

if [[ ! -f "$in_path" ]]; then
  echo "Input file not found: $in_path" >&2
  exit 1
fi

mkdir -p "$(dirname "$out_path")"

node --input-type=module - <<'NODE' "$in_path" "$out_path"
import * as fs from 'node:fs';
import * as path from 'node:path';

const inPath = process.argv[2];
const outPath = process.argv[3];

function normalizeIso(ts) {
  if (!ts) return new Date(0).toISOString();
  // Handles e.g. 2025-12-25T00:47:40.448498266-08:00
  // JS Date truncates beyond milliseconds but parses offsets.
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) {
    // Last resort: try to drop sub-ms fractional seconds.
    const m = String(ts).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/);
    if (m) {
      const fallback = `${m[1]}${m[3]}`;
      const d2 = new Date(fallback);
      if (Number.isFinite(d2.getTime())) return d2.toISOString();
    }
    return new Date(0).toISOString();
  }
  return d.toISOString();
}

function mapStatus(s) {
  if (s === 'open') return 'open';
  if (s === 'in_progress') return 'in-progress';
  if (s === 'closed') return 'completed';
  if (s === 'tombstone') return 'deleted';
  return 'open';
}

function mapPriority(p) {
  const n = typeof p === 'number' ? p : parseInt(String(p ?? ''), 10);
  if (n === 0) return 'critical';
  if (n === 1) return 'high';
  if (n === 2) return 'medium';
  return 'low';
}

function toStringOrEmpty(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function arrayOrEmpty(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x));
}

function buildDescription(issue) {
  const parts = [];
  if (issue.description) parts.push(String(issue.description));
  if (issue.acceptance_criteria) {
    parts.push(`\n\nAcceptance Criteria\n${String(issue.acceptance_criteria)}`);
  }
  if (issue.notes) {
    parts.push(`\n\nNotes\n${String(issue.notes)}`);
  }
  if (issue.external_ref) {
    parts.push(`\n\nExternal Ref\n${String(issue.external_ref)}`);
  }
  // Keep it deterministic
  return parts.join('');
}

const outLines = [];
const input = fs.readFileSync(inPath, 'utf-8');
const lines = input.split('\n').filter(l => l.trim() !== '');

// Parse all issues first so we can build an ID mapping (original -> ALL CAPS)
const rawIssues = lines.map(l => JSON.parse(l));
const idMap = new Map();
for (const issue of rawIssues) {
  const orig = String(issue.id);
  idMap.set(orig, orig.toUpperCase());
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const issue of rawIssues) {
  // Parent mapping: for child issues, if there is a parent-child dependency,
  // the depends_on_id is the parent.
  let parentId = null;
  if (Array.isArray(issue.dependencies)) {
    const rel = issue.dependencies.find(d => d && d.type === 'parent-child' && d.issue_id === issue.id);
    if (rel && rel.depends_on_id) {
      const origParent = String(rel.depends_on_id);
      parentId = idMap.get(origParent) || origParent.toUpperCase();
    }
  }

  // Build description and convert any mentions of known IDs to ALL CAPS
  let description = buildDescription(issue);
  for (const [orig, upper] of idMap.entries()) {
    const re = new RegExp(escapeRegExp(orig), 'gi');
    description = description.replace(re, upper);
  }

  const workItem = {
    id: idMap.get(String(issue.id)),
    title: toStringOrEmpty(issue.title),
    description,
    status: mapStatus(issue.status),
    priority: mapPriority(issue.priority),
    parentId,
    createdAt: normalizeIso(issue.created_at),
    updatedAt: normalizeIso(issue.updated_at),
    tags: arrayOrEmpty(issue.labels),
    assignee: toStringOrEmpty(issue.assignee),
    stage: '',
    issueType: toStringOrEmpty(issue.issue_type),
    createdBy: toStringOrEmpty(issue.created_by),
    deletedBy: toStringOrEmpty(issue.deleted_by),
    deleteReason: toStringOrEmpty(issue.delete_reason),
  };
  outLines.push(JSON.stringify({ type: 'workitem', data: workItem }));

  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (const c of comments) {
    // Convert any mentions in comment text to ALL CAPS for known IDs
    let commentText = toStringOrEmpty(c.text);
    for (const [orig, upper] of idMap.entries()) {
      const re = new RegExp(escapeRegExp(orig), 'gi');
      commentText = commentText.replace(re, upper);
    }

    const comment = {
      id: `${workItem.id}-C${toStringOrEmpty(c.id)}`,
      workItemId: workItem.id,
      author: toStringOrEmpty(c.author),
      comment: commentText,
      createdAt: normalizeIso(c.created_at),
      references: [],
    };
    outLines.push(JSON.stringify({ type: 'comment', data: comment }));
  }
}

fs.writeFileSync(outPath, outLines.join('\n') + (outLines.length ? '\n' : ''), 'utf-8');
process.stderr.write(`Wrote ${outLines.length} records to ${outPath}\n`);
NODE
