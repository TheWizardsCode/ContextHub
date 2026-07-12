#!/usr/bin/env node
// Keep as CommonJS by using .cjs extension; Node will still run this when
// invoked via `node scripts/test-timings.cjs`.
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
    // Vitest prints a JSON object; try to parse the full stdout. If there is
    // additional log noise, attempt to find the last JSON object in the output.
    let json = null
    try { json = JSON.parse(stdout) } catch (e) {
      const idx = stdout.lastIndexOf('{')
      if (idx !== -1) json = JSON.parse(stdout.slice(idx))
    }

    const tests = (json && (json.tests || json.results || json.testResults)) || []

    const rows = []
    for (const t of tests) {
      // Vitest test entries vary by reporter; attempt common shapes
      if (t.name && t.duration != null) {
        rows.push({ file: t.file || t.location || null, title: t.name, durationMs: t.duration })
        continue
      }
      if (t.assertionResults && Array.isArray(t.assertionResults)) {
        for (const a of t.assertionResults) rows.push({ file: t.name, title: a.fullName || a.title || a, durationMs: a.duration || null })
      }
    }

    // Fallback: if rows empty try to extract from nested structures
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
