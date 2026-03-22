'use client'

import { useState, useEffect, useCallback } from 'react'
import type { FeatureCollection } from 'geojson'

interface UseGeoJSONResult {
  data: FeatureCollection | null
  loading: boolean
  error: string | null
}

const cache = new Map<string, FeatureCollection>()

export function useGeoJSON(filename: string, habilitado: boolean = true): UseGeoJSONResult {
  const [data, setData] = useState<FeatureCollection | null>(
    cache.get(filename) ?? null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!habilitado) return

    if (cache.has(filename)) {
      setData(cache.get(filename)!)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        const res = await fetch(`/data/${filename}`)
        if (!res.ok) throw new Error(`Error cargando ${filename}: ${res.status}`)
        const geojson = await res.json()

        if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
          throw new Error(`${filename} no es un FeatureCollection válido`)
        }

        cache.set(filename, geojson)
        if (!cancelled) {
          setData(geojson)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error desconocido')
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [filename, habilitado])

  return { data, loading, error }
}

export function precargarGeoJSON(filename: string): void {
  if (cache.has(filename)) return

  fetch(`/data/${filename}`)
    .then(res => res.json())
    .then(geojson => {
      if (geojson.type === 'FeatureCollection') {
        cache.set(filename, geojson)
      }
    })
    .catch(() => {})
}
