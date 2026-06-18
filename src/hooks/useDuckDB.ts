'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import * as duckdb from '@duckdb/duckdb-wasm'

type DuckDBState =
  | { status: 'loading' }
  | { status: 'ready'; db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }
  | { status: 'error'; error: string }

let globalPromise: Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> | null = null

async function initDuckDB(): Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> {
  const bundles = duckdb.getJsDelivrBundles()

  const localBundles: duckdb.DuckDBBundles = {
    mvp: {
      mainModule: '/duckdb/duckdb-mvp.wasm',
      mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
    },
    eh: {
      mainModule: '/duckdb/duckdb-eh.wasm',
      mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
    },
  }

  let bundle: duckdb.DuckDBBundle
  try {
    const localCheck = await fetch('/duckdb/duckdb-mvp.wasm', { method: 'HEAD' })
    bundle = localCheck.ok
      ? await duckdb.selectBundle(localBundles)
      : await duckdb.selectBundle(bundles)
  } catch {
    bundle = await duckdb.selectBundle(bundles)
  }

  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)

  const conn = await db.connect()

  await conn.query(`
    SET enable_http_metadata_cache=true;
    SET enable_object_cache=true;
  `)

  return { db, conn }
}

export function useDuckDB(): DuckDBState {
  const [state, setState] = useState<DuckDBState>({ status: 'loading' })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    if (!globalPromise) {
      globalPromise = initDuckDB()
    }

    globalPromise
      .then(({ db, conn }) => {
        if (mountedRef.current) {
          setState({ status: 'ready', db, conn })
        }
      })
      .catch((err) => {
        globalPromise = null
        if (mountedRef.current) {
          setState({ status: 'error', error: err?.message ?? 'DuckDB init failed' })
        }
      })

    return () => {
      mountedRef.current = false
    }
  }, [])

  return state
}

export function useDuckDBQuery<T>(
  state: DuckDBState,
  sql: string | null,
  deps: unknown[] = []
): { data: T[] | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (state.status !== 'ready' || !sql) return
    setLoading(true)
    setError(null)
    try {
      const result = await state.conn.query(sql)
      const rows = result.toArray().map((row: Record<string, unknown>) => {
        const obj: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) {
          obj[key] = typeof value === 'bigint' ? Number(value) : value
        }
        return obj as T
      })
      setData(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, sql, ...deps])

  useEffect(() => {
    run()
  }, [run])

  return { data, loading, error }
}
