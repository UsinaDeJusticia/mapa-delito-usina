'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useDuckDB } from './useDuckDB'
import type { FiltrosActivos } from '@/components/mapa/FiltrosSAT'
import { numeroONull, sumarConDato } from '@/lib/mapa/metricas'

interface ProvinciaData {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
  totalHechos: number
  // null = la fuente no informa el dato. Ver src/lib/mapa/metricas.ts.
  totalVictimas: number | null
  victimasParcial?: boolean
  delitos: Array<{ nombre: string; hechos: number; victimas: number | null }>
}

interface MapaDataResult {
  provincias: ProvinciaData[]
  aniosDisponibles: number[]
  loading: boolean
  source: 'duckdb' | 'api' | null
}

const PROVINCIAS_CENTROIDES: Record<string, { latitud: number; longitud: number; nombre: string }> = {
  '02': { latitud: -34.6037, longitud: -58.3816, nombre: 'CABA' },
  '06': { latitud: -34.9215, longitud: -57.9545, nombre: 'Buenos Aires' },
  '10': { latitud: -28.4696, longitud: -65.7852, nombre: 'Catamarca' },
  '14': { latitud: -31.4201, longitud: -64.1888, nombre: 'Córdoba' },
  '18': { latitud: -28.4696, longitud: -57.9862, nombre: 'Corrientes' },
  '22': { latitud: -26.3864, longitud: -60.7658, nombre: 'Chaco' },
  '26': { latitud: -43.3000, longitud: -65.1000, nombre: 'Chubut' },
  '30': { latitud: -31.7413, longitud: -60.1556, nombre: 'Entre Ríos' },
  '34': { latitud: -26.1775, longitud: -58.1781, nombre: 'Formosa' },
  '38': { latitud: -24.1858, longitud: -65.2995, nombre: 'Jujuy' },
  '42': { latitud: -36.6167, longitud: -64.2833, nombre: 'La Pampa' },
  '46': { latitud: -29.4131, longitud: -66.8559, nombre: 'La Rioja' },
  '50': { latitud: -34.6299, longitud: -68.3280, nombre: 'Mendoza' },
  '54': { latitud: -27.3621, longitud: -55.9008, nombre: 'Misiones' },
  '58': { latitud: -38.9516, longitud: -68.0591, nombre: 'Neuquén' },
  '62': { latitud: -40.8135, longitud: -63.0000, nombre: 'Río Negro' },
  '66': { latitud: -24.7821, longitud: -65.4232, nombre: 'Salta' },
  '70': { latitud: -31.5375, longitud: -68.5364, nombre: 'San Juan' },
  '74': { latitud: -33.2962, longitud: -66.3280, nombre: 'San Luis' },
  '78': { latitud: -48.8154, longitud: -69.9557, nombre: 'Santa Cruz' },
  '82': { latitud: -31.6107, longitud: -60.6973, nombre: 'Santa Fe' },
  '86': { latitud: -27.7824, longitud: -64.2642, nombre: 'Santiago del Estero' },
  '90': { latitud: -26.8083, longitud: -65.2176, nombre: 'Tucumán' },
  '94': { latitud: -54.8019, longitud: -68.3030, nombre: 'Tierra del Fuego' },
}

function padId(id: string): string {
  return id.padStart(2, '0')
}

/**
 * Este es el camino por defecto del mapa: DuckDB sobre los Parquet, en el
 * browser. La API es el respaldo. Así que la distinción entre "sin dato" y
 * "cero" tiene que hacerse acá igual que en `src/lib/mapa/queries.ts`, o el
 * arreglo del servidor no se ve nunca.
 *
 * `SUM(cantidad_victimas)` en Parquet devuelve NULL cuando ninguna fila del
 * grupo trae el dato, exactamente como en Postgres.
 */
function enrichWithCentroids(
  rows: Array<{
    provincia_id: string
    provincia_nombre: string
    total_hechos: number
    total_victimas: number | null
    tipo_delito_nombre?: string
    femicidios?: number
  }>,
  fuente: 'snic' | 'sat'
): ProvinciaData[] {
  const map = new Map<string, ProvinciaData>()

  for (const row of rows) {
    const paddedId = padId(String(row.provincia_id))
    const centroide = PROVINCIAS_CENTROIDES[paddedId]
    if (!centroide) continue

    const hechos = numeroONull(row.total_hechos) ?? 0
    const victimas = numeroONull(row.total_victimas)

    const existing = map.get(paddedId)
    if (existing) {
      existing.totalHechos += hechos
      existing.totalVictimas = sumarConDato(existing.totalVictimas, victimas)
      if (victimas === null) existing.victimasParcial = true
      if (row.tipo_delito_nombre) {
        existing.delitos.push({ nombre: row.tipo_delito_nombre, hechos, victimas })
      }
    } else {
      const delitoNombre = fuente === 'sat'
        ? 'Homicidios dolosos'
        : (row.tipo_delito_nombre || 'Todos los delitos')

      map.set(paddedId, {
        provincia: row.provincia_nombre || centroide.nombre,
        provinciaId: paddedId,
        latitud: centroide.latitud,
        longitud: centroide.longitud,
        totalHechos: hechos,
        totalVictimas: victimas,
        victimasParcial: false,
        delitos: [{ nombre: delitoNombre, hechos, victimas }],
      })
    }
  }

  // Sin ningún dato no hay total parcial: no hay nada que se esté sumando a medias.
  const provincias = Array.from(map.values())
  for (const p of provincias) {
    if (p.totalVictimas === null) p.victimasParcial = false
  }
  return provincias
}

async function queryDuckDB(
  conn: { query: (sql: string) => Promise<{ toArray: () => Array<Record<string, unknown>> }> },
  anio: number,
  fuente: 'snic' | 'sat',
  tipoDelitoId?: string,
  filtrosSAT?: FiltrosActivos
): Promise<{ provincias: ProvinciaData[]; aniosDisponibles: number[] }> {

  let sql: string

  if (fuente === 'snic') {
    if (tipoDelitoId) {
      sql = `
        SELECT provincia_id, provincia_nombre,
               total_hechos, total_victimas, tipo_delito_nombre
        FROM read_parquet('/data/snic_provincia_delito.parquet')
        WHERE anio = ${anio} AND tipo_delito_id = '${tipoDelitoId.replace(/'/g, "''")}'
        ORDER BY provincia_nombre
      `
    } else {
      sql = `
        SELECT provincia_id, provincia_nombre,
               total_hechos, total_victimas
        FROM read_parquet('/data/snic_provincia.parquet')
        WHERE anio = ${anio}
        ORDER BY provincia_nombre
      `
    }
  } else {
    const hasFiltros = filtrosSAT && (filtrosSAT.sexo || filtrosSAT.arma || filtrosSAT.vinculo || filtrosSAT.lugar)

    if (hasFiltros) {
      const conditions: string[] = [
        `anio = ${anio}`,
        `provincia IS NOT NULL`,
      ]
      if (filtrosSAT!.sexo) conditions.push(`victima_sexo = '${filtrosSAT!.sexo.replace(/'/g, "''")}'`)
      if (filtrosSAT!.arma) conditions.push(`medio_comision = '${filtrosSAT!.arma.replace(/'/g, "''")}'`)
      if (filtrosSAT!.vinculo) conditions.push(`vinculo = '${filtrosSAT!.vinculo.replace(/'/g, "''")}'`)
      if (filtrosSAT!.lugar) conditions.push(`lugar_hecho = '${filtrosSAT!.lugar.replace(/'/g, "''")}'`)

      sql = `
        SELECT provincia_id, provincia AS provincia_nombre,
               COUNT(*)::INT AS total_hechos,
               SUM(cantidad_victimas)::INT AS total_victimas
        FROM read_parquet('/data/hechos_sat.parquet')
        WHERE ${conditions.join(' AND ')}
        GROUP BY provincia_id, provincia
        ORDER BY provincia
      `
    } else {
      sql = `
        SELECT provincia_id, provincia_nombre,
               total_hechos, total_victimas, femicidios
        FROM read_parquet('/data/sat_provincia.parquet')
        WHERE anio = ${anio}
        ORDER BY provincia_nombre
      `
    }
  }

  const result = await conn.query(sql)
  const rows = result.toArray().map((row: Record<string, unknown>) => {
    const obj: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      obj[key] = typeof value === 'bigint' ? Number(value) : value
    }
    return obj as {
      provincia_id: string
      provincia_nombre: string
      total_hechos: number
      total_victimas: number | null
      tipo_delito_nombre?: string
      femicidios?: number
    }
  })

  const aniosFuente = fuente === 'snic' ? 'snic' : 'sat'
  const aniosResult = await conn.query(`
    SELECT anio FROM read_parquet('/data/anios_disponibles.parquet')
    WHERE fuente = '${aniosFuente}'
    ORDER BY anio
  `)
  const aniosDisponibles = aniosResult.toArray().map((r: Record<string, unknown>) => Number(r.anio))

  return {
    provincias: enrichWithCentroids(rows, fuente),
    aniosDisponibles,
  }
}

async function fetchFromAPI(
  anio: number,
  fuente: 'snic' | 'sat',
  tipoDelitoId?: string,
  filtrosSAT?: FiltrosActivos,
  signal?: AbortSignal
): Promise<{ provincias: ProvinciaData[]; aniosDisponibles: number[] }> {
  const params = new URLSearchParams()
  params.set('anio', String(anio))
  params.set('fuente', fuente)
  if (tipoDelitoId) params.set('tipo_delito_id', tipoDelitoId)
  if (fuente === 'sat' && filtrosSAT) {
    if (filtrosSAT.sexo) params.set('sexo', filtrosSAT.sexo)
    if (filtrosSAT.arma) params.set('arma', filtrosSAT.arma)
    if (filtrosSAT.vinculo) params.set('vinculo', filtrosSAT.vinculo)
    if (filtrosSAT.lugar) params.set('lugar', filtrosSAT.lugar)
  }

  const res = await fetch(`/api/mapa/estadisticas?${params}`, { signal })
  if (!res.ok) throw new Error('API error')
  const data = await res.json()
  return {
    provincias: data.provincias,
    aniosDisponibles: data.aniosDisponibles,
  }
}

export function useMapaData(
  anio: number,
  fuente: 'snic' | 'sat',
  tipoDelitoId?: string,
  filtrosSAT?: FiltrosActivos
): MapaDataResult {
  const duckState = useDuckDB()
  const duckConn = duckState.status === 'ready' ? duckState.conn : null
  const [result, setResult] = useState<MapaDataResult>({
    provincias: [],
    aniosDisponibles: [],
    loading: true,
    source: null,
  })
  const abortRef = useRef<AbortController | null>(null)

  const loadData = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setResult(prev => ({ ...prev, loading: true }))

    try {
      if (duckConn) {
        const data = await queryDuckDB(duckConn, anio, fuente, tipoDelitoId, filtrosSAT)
        if (!controller.signal.aborted) {
          setResult({ ...data, loading: false, source: 'duckdb' })
        }
        return
      }

      if (duckState.status === 'error') {
        const data = await fetchFromAPI(anio, fuente, tipoDelitoId, filtrosSAT, controller.signal)
        if (!controller.signal.aborted) {
          setResult({ ...data, loading: false, source: 'api' })
        }
        return
      }
    } catch {
      if (controller.signal.aborted) return

      try {
        const data = await fetchFromAPI(anio, fuente, tipoDelitoId, filtrosSAT, controller.signal)
        if (!controller.signal.aborted) {
          setResult({ ...data, loading: false, source: 'api' })
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult(prev => ({ ...prev, loading: false }))
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duckState.status, duckConn, anio, fuente, tipoDelitoId, filtrosSAT])

  useEffect(() => {
    if (duckState.status === 'loading') return
    loadData()
    return () => {
      abortRef.current?.abort()
    }
  }, [loadData, duckState.status])

  return result
}

export function useSATOpciones(): {
  opciones: Record<string, Array<{ valor: string; total: number }>> | null
  loading: boolean
  source: 'duckdb' | 'api' | null
} {
  const duckState = useDuckDB()
  const duckConn = duckState.status === 'ready' ? duckState.conn : null
  const [opciones, setOpciones] = useState<Record<string, Array<{ valor: string; total: number }>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<'duckdb' | 'api' | null>(null)

  useEffect(() => {
    if (duckState.status === 'loading') return

    async function load() {
      setLoading(true)
      try {
        if (duckConn) {
          const queries = {
            sexo: `SELECT victima_sexo AS valor, COUNT(*)::INT AS total FROM read_parquet('/data/hechos_sat.parquet') WHERE victima_sexo IS NOT NULL GROUP BY victima_sexo ORDER BY total DESC`,
            arma: `SELECT medio_comision AS valor, COUNT(*)::INT AS total FROM read_parquet('/data/hechos_sat.parquet') WHERE medio_comision IS NOT NULL GROUP BY medio_comision ORDER BY total DESC`,
            femicidio: `SELECT femicidio AS valor, COUNT(*)::INT AS total FROM read_parquet('/data/hechos_sat.parquet') WHERE femicidio IS NOT NULL GROUP BY femicidio ORDER BY total DESC`,
            vinculo: `SELECT vinculo AS valor, COUNT(*)::INT AS total FROM read_parquet('/data/hechos_sat.parquet') WHERE vinculo IS NOT NULL GROUP BY vinculo ORDER BY total DESC`,
            lugar: `SELECT lugar_hecho AS valor, COUNT(*)::INT AS total FROM read_parquet('/data/hechos_sat.parquet') WHERE lugar_hecho IS NOT NULL GROUP BY lugar_hecho ORDER BY total DESC`,
          }

          const result: Record<string, Array<{ valor: string; total: number }>> = {}
          for (const [key, sql] of Object.entries(queries)) {
            const r = await duckConn.query(sql)
            result[key] = r.toArray().map((row: Record<string, unknown>) => ({
              valor: String(row.valor),
              total: Number(row.total),
            }))
          }
          setOpciones(result)
          setSource('duckdb')
          setLoading(false)
          return
        }

        const res = await fetch('/api/mapa/sat-opciones')
        if (res.ok) {
          const data = await res.json()
          setOpciones(data)
          setSource('api')
        }
      } catch {
        try {
          const res = await fetch('/api/mapa/sat-opciones')
          if (res.ok) {
            const data = await res.json()
            setOpciones(data)
            setSource('api')
          }
        } catch { /* silently fail */ }
      } finally {
        setLoading(false)
      }
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duckState.status, duckConn])

  return { opciones, loading, source }
}
