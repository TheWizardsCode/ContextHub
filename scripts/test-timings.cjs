#!/usr/bin/env node
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// Runs vitest with JSON reporter and writes a concise timings report to
// test-timings.json in the repository root.

const args = ['vitest', 'run', '--reporter', 'json']
const proc = spawn('npx', args, { stdio: ['ignore', 'pipe', 'inherit'] })

let stdout = ''
proc.stdout.on('data', (c) => { stdout += c.toString() })

proc.on('close', (code) => {
  try {
    // Strip ANSI / control sequences that some tests (TUI) emit to stdout
    const cleaned = stdout.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    let json = null
    try { json = JSON.parse(cleaned) } catch (e) {
      // Fallback: extract substring between first '{' and last '}' to handle
      // log noise surrounding the JSON output from some tests.
      const first = cleaned.indexOf('{')
      const last = cleaned.lastIndexOf('}')
      if (first !== -1 && last !== -1 && last > first) {
        const sub = cleaned.slice(first, last + 1)
        json = JSON.parse(sub)
      } else {
        const idx = cleaned.lastIndexOf('{')
        if (idx !== -1) json = JSON.parse(cleaned.slice(idx))
      }
    }

    const tests = (json && (json.tests || json.results || json.testResults)) || []

    const rows = []
    for (const t of tests) {
      if (t.name && t.duration != null) {
        rows.push({ file: t.file || t.location || null, title: t.name, durationMs: t.duration })
        continue
      }
      if (t.assertionResults && Array.isArray(t.assertionResults)) {
        for (const a of t.assertionResults) rows.push({ file: t.name, title: a.fullName || a.title || a, durationMs: a.duration || null })
      }
    }

    if (rows.length === 0 && json && json.results) {
      for (const res of json.results) {
        if (res.assertionResults) for (const a of res.assertionResults) rows.push({ file: res.name, title: a.fullName || a.title, durationMs: a.duration || null })
      }
    }

    const outPath = path.resolve(process.cwd(), 'test-timings.json')
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2))
    console.log('Wrote timings to', outPath)
    process.exit(code)
  } catch (err) {
    console.error('Failed to parse vitest JSON output:', err.message)
    console.error('Raw output head:', stdout.slice(0, 2000))
    process.exit(2)
  }
})
