#!/usr/bin/env node
// scripts/validate-cli-md.cjs
// Validate that CLI.md includes all top-level commands from `wl --help`.

/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runHelp() {
  const bin = path.join(__dirname, '..', 'dist', 'cli.js');
  if (!fs.existsSync(bin)) {
    console.error('Built CLI not found at dist/cli.js');
    process.exit(2);
  }
  const res = spawnSync('node', [bin, '--help'], { encoding: 'utf8' });
  if (res.error) {
    console.error('Failed to execute CLI:', res.error.message);
    process.exit(2);
  }
  return res.stdout || '';
}

function readCliMd() {
  const mdPath = path.join(__dirname, '..', 'CLI.md');
  if (!fs.existsSync(mdPath)) {
    console.error('CLI.md not found at repository root');
    process.exit(2);
  }
  return fs.readFileSync(mdPath, 'utf8');
}

function extractCommands(helpText) {
  const lines = helpText.split(/\r?\n/);
  const commands = [];
  // Only capture lines that start with two spaces and a letter (avoid options like -V)
  for (const line of lines) {
    const m = line.match(/^\s{2}([a-z][a-z0-9|\-]*)\b.*$/i);
    if (m) commands.push(m[1]);
  }
  return commands;
}

function validate() {
  const helpText = runHelp();
  const md = readCliMd();

  const commands = extractCommands(helpText).filter(Boolean);
  const missing = [];
  function escapeForRegex(s) {
    return s.replace(/[-\\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  for (const cmd of commands) {
    const alt = cmd.split('|')[0];
    const backticked = md.indexOf('`' + alt + '`') !== -1 || md.indexOf('`' + cmd + '`') !== -1;
    const wordRe = new RegExp('\\b' + escapeForRegex(alt) + '\\b', 'm');
    const found = backticked || wordRe.test(md);
    if (!found) missing.push(cmd);
  }

  if (missing.length === 0) {
    console.log('OK: All help commands present in CLI.md');
    process.exit(0);
  }

  console.error('Missing commands in CLI.md:');
  for (const m of missing) console.error(' -', m);
  process.exit(1);
}

validate();
