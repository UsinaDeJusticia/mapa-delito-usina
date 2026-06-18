'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { latLngToCell } from 'h3-js'
import { useDuckDB } from './useDuckDB'

export interface H3Cell {
  h3Index: string
  count: number
  victimas: number
}

interface H3DensityResult {
  cells: H3Cell[]
  loading: boolean
  maxCount: number
}

const ZOOM_TO_RESOLUTION: Record<number, number> = {
  4: 3, 5: 3, 6: 4, 7: 5, 8: 5, 9: 6, 10: 7, 11: 7, 12: 8, 13: 9, 14: 9,
}

export function getH3Resolution(zoom: number): number {
  if (zoom <= 4) return 3
  if (zoom >= 14) return 9
  return ZOOM_TO_RESOLUTION[zoom] ?? 5
}

export function useH3Density(
  anio: number | null,
  resolution: number,
  enabled: boolean
): H3DensityResult {
  const duckState = useDuckDB()
  const duckConn = duckState.status === 'ready' ? duckState.conn : null
  const [cells, setCells] = useState<H3Cell[]>([])
  const [loading, setLoading] = useState(false)
  const [maxCount, setMaxCount] = useState(0)
  const cacheRef = useRef<Map<string, H3Cell[]>>(new Map())

  const compute = useCallback(async () => {
    if (!enabled || !duckConn || anio === null) {
      setCells([])
      setMaxCount(0)
      return
    }

    const cacheKey = `${anio}-${resolution}`
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      setCells(cached)
      setMaxCount(Math.max(...cached.map(c => c.count), 0))
      return
    }

    setLoading(true)
    try {
      const result = await duckConn.query(`
        SELECT latitud, longitud, cantidad_victimas
        FROM read_parquet('/data/hechos_sat.parquet')
        WHERE anio = ${anio}
          AND latitud IS NOT NULL
          AND longitud IS NOT NULL
      `)

      const rows = result.toArray() as Array<{ latitud: number; longitud: number; cantidad_victimas: number }>

      const cellMap = new Map<string, { count: number; victimas: number }>()
      for (const row of rows) {
        const lat = Number(row.latitud)
        const lng = Number(row.longitud)
        if (lat === 0 && lng === 0) continue

        const h3Index = latLngToCell(lat, lng, resolution)
        const existing = cellMap.get(h3Index)
        if (existing) {
          existing.count++
          existing.victimas += Number(row.cantidad_victimas) || 1
        } else {
          cellMap.set(h3Index, { count: 1, victimas: Number(row.cantidad_victimas) || 1 })
        }
      }

      const computed: H3Cell[] = Array.from(cellMap.entries()).map(([h3Index, data]) => ({
        h3Index,
        count: data.count,
        victimas: data.victimas,
      }))

      cacheRef.current.set(cacheKey, computed)
      const max = Math.max(...computed.map(c => c.count), 0)
      setCells(computed)
      setMaxCount(max)
    } catch (err) {
      console.error('H3 density computation failed:', err)
      setCells([])
      setMaxCount(0)
    } finally {
      setLoading(false)
    }
  }, [duckConn, anio, resolution, enabled])

  useEffect(() => {
    compute()
  }, [compute])

  return { cells, loading, maxCount }
}
