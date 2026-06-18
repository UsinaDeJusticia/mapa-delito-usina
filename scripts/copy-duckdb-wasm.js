/**
 * Postinstall: copy DuckDB-WASM assets to public/duckdb/
 * so the browser can load them via HTTP.
 *
 * Run: node scripts/copy-duckdb-wasm.js
 */
const fs = require('fs')
const path = require('path')

const DIST = path.join(__dirname, '..', 'node_modules', '@duckdb', 'duckdb-wasm', 'dist')
const DEST = path.join(__dirname, '..', 'public', 'duckdb')

const FILES = [
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
]

if (!fs.existsSync(DEST)) {
  fs.mkdirSync(DEST, { recursive: true })
}

for (const f of FILES) {
  const src = path.join(DIST, f)
  const dst = path.join(DEST, f)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst)
    console.log(`  ✓ ${f}`)
  } else {
    console.warn(`  ⚠ ${f} not found`)
  }
}

console.log('DuckDB-WASM assets copied to public/duckdb/')
