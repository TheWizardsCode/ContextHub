#!/usr/bin/env node
// Simple build helper: reads package.json and writes src/version.ts and
// patches dist/version.js after tsc compiles it. This script is intended
// to be run as part of the npm build step (after tsc).
const fs = require('fs');
const path = require('path');

function readPackageVersion() {
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return String(pkg.version || '0.0.0');
}

function writeSrcVersion(version) {
  const out = `// Auto-generated; do not edit.\nexport const WORKLOG_VERSION = '${version}';\n`;
  fs.writeFileSync(path.resolve(process.cwd(), 'src/version.ts'), out, 'utf8');
}

function patchDistVersion(version) {
  const distPath = path.resolve(process.cwd(), 'dist/version.js');
  if (!fs.existsSync(distPath)) return;
  const raw = fs.readFileSync(distPath, 'utf8');
  const patched = raw.replace(/WORKLOG_VERSION = '(\d+\.\d+\.\d+)'/, `WORKLOG_VERSION = '${version}'`);
  fs.writeFileSync(distPath, patched, 'utf8');
}

function main() {
  const v = readPackageVersion();
  writeSrcVersion(v);
  patchDistVersion(v);
}

main();
