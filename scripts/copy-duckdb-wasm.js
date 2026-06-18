/**
 * Postinstall: copy DuckDB-WASM assets to public/duckdb/
 * so the browser can load them via HTTP.
 *
 * Non-blocking: if files are missing, warns but does not fail the install.
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

try {
  if (!fs.existsSync(DIST)) {
    console.log('DuckDB-WASM dist not found — skipping copy (will use CDN fallback)')
    process.exit(0)
  }

  if (!fs.existsSync(DEST)) {
    fs.mkdirSync(DEST, { recursive: true })
  }

  let copied = 0
  for (const f of FILES) {
    const src = path.join(DIST, f)
    const dst = path.join(DEST, f)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
      copied++
    }
  }

  console.log(`DuckDB-WASM: ${copied}/${FILES.length} assets copied to public/duckdb/`)
} catch (err) {
  console.warn('DuckDB-WASM copy failed (non-fatal, will use CDN fallback):', err.message)
  process.exit(0)
}
