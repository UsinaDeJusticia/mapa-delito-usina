'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import { PanelEstadisticas } from './PanelEstadisticas'
import { SliderAnios } from './SliderAnios'
import { SelectorDelito } from './SelectorDelito'
import { BuscadorProvincia } from './BuscadorProvincia'
// import { FiltroDepartamento } from './FiltroDepartamento' // Fase 2
import { SelectorFuente } from './SelectorFuente'
import { FiltrosSAT, FiltrosActivos } from './FiltrosSAT'
import { MAPA_STYLE_USINA } from '@/config/mapStyles'

import {
  MascaraPaises,
  CapaProvincias,
  CapaDepartamentos,
  MarcadoresCirculares,
} from './capas'

import { useGeolocalizacion } from './hooks/useGeolocalizacion'
import { precargarGeoJSON } from './hooks/useGeoJSON'

// ─── Tipos ───────────────────────────────────────────────
interface ProvinciaData {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
  totalHechos: number
  totalVictimas: number
  delitos: Array<{ nombre: string; hechos: number; victimas: number }>
}

interface EstadisticasResponse {
  anio: number
  provincias: ProvinciaData[]
  aniosDisponibles: number[]
  totalRegistros: number
}

interface MapaDelitoProps {
  anio?: number
  tipoDelitoId?: string
}

// ─── Configuración ───────────────────────────────────────
const ARGENTINA_CENTER = { lat: -38.4161, lng: -63.6167 }
const ARGENTINA_ZOOM = 4
const QUILMES_DEPTO_ID = '06658'

// ─── Componente interno para precarga inteligente ────────
function PrecargaInteligente() {
  const map = useMap()

  useEffect(() => {
    if (!map) return

    // Precargar departamentos solo cuando el usuario hace zoom >= 6
    // (alineado con el threshold de CapaDepartamentos — zoomMinimo - 1 = 6)
    // Sin timer: 0 bytes de departamentos en carga inicial
    const listener = map.addListener('zoom_changed', () => {
      const zoom = map.getZoom() ?? 4
      if (zoom >= 6) {
        precargarGeoJSON('departamentos-poligonos.geojson')
        google.maps.event.removeListener(listener)
      }
    })

    return () => {
      google.maps.event.removeListener(listener)
    }
  }, [map])

  return null
}

// ─── Botón recentrar ubicación ───────────────────────────
function BotonRecentrar({
  disponible,
  onClick,
}: {
  disponible: boolean
  onClick: () => void
}) {
  if (!disponible) return null

  return (
    <button
      onClick={onClick}
      className="absolute bottom-6 right-4 z-10 bg-white/95 backdrop-blur-sm rounded-full shadow-lg w-10 h-10 flex items-center justify-center hover:bg-white transition-colors"
      title="Ir a mi ubicación"
      aria-label="Centrar en mi ubicación"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#1E427C"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    </button>
  )
}

// ─── Componente principal ────────────────────────────────
export default function MapaDelito({ anio: anioProp, tipoDelitoId: tipoDelitoProp }: MapaDelitoProps) {
  const [anioSeleccionado, setAnioSeleccionado] = useState(anioProp ?? 2024)
  const [aniosDisponibles, setAniosDisponibles] = useState<number[]>([])
  const [datos, setDatos] = useState<ProvinciaData[]>([])
  const [provinciaSeleccionada, setProvinciaSeleccionada] = useState<ProvinciaData | null>(null)
  // const [departamentoSeleccionado, setDepartamentoSeleccionado] = useState<string | null>(null) // Fase 2
  const [tipoDelitoId, setTipoDelitoId] = useState<string | undefined>(tipoDelitoProp)
  const [fuenteSeleccionada, setFuenteSeleccionada] = useState<'snic' | 'sat'>('snic')
  const [filtrosSAT, setFiltrosSAT] = useState<FiltrosActivos>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [provinciaHover, setProvinciaHover] = useState<string | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || ''

  // Geolocalización (no bloquea la carga — el mapa aparece de inmediato)
  const { ubicacion, cargando: geoCargando, disponible: geoDisponible } = useGeolocalizacion()

  // Cuando la geolocalización llega, mover el mapa suavemente
  useEffect(() => {
    if (!geoCargando && ubicacion.origen === 'gps' && mapRef.current) {
      mapRef.current.panTo({ lat: ubicacion.lat, lng: ubicacion.lng })
      mapRef.current.setZoom(ubicacion.zoom)
    }
  }, [geoCargando, ubicacion])

  // ─── Fetch datos ─────────────────────────────────────
  const fetchDatos = useCallback(async () => {
    // Cancelar fetch anterior si existe
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const controller = new AbortController()
    abortControllerRef.current = controller

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        anio: anioSeleccionado.toString(),
        fuente: fuenteSeleccionada,
      })
      if (fuenteSeleccionada === 'snic' && tipoDelitoId) {
        params.set('tipo_delito_id', tipoDelitoId)
      }
      // Filtros SAT
      if (fuenteSeleccionada === 'sat') {
        if (filtrosSAT.sexo) params.set('sexo', filtrosSAT.sexo)
        if (filtrosSAT.arma) params.set('arma', filtrosSAT.arma)
        if (filtrosSAT.vinculo) params.set('vinculo', filtrosSAT.vinculo)
        if (filtrosSAT.lugar) params.set('lugar', filtrosSAT.lugar)
      }

      const res = await fetch(`/api/mapa/estadisticas?${params}`, {
        signal: controller.signal,
      })

      if (!res.ok) throw new Error('Error al cargar datos')

      const data: EstadisticasResponse = await res.json()

      // Solo actualizar si este fetch no fue cancelado
      if (!controller.signal.aborted) {
        setDatos(data.provincias)
        setAniosDisponibles(data.aniosDisponibles)
      }
    } catch (err) {
      // Ignorar errores de abort
      if (err instanceof DOMException && err.name === 'AbortError') return
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Error desconocido')
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [anioSeleccionado, tipoDelitoId, fuenteSeleccionada, filtrosSAT])

  useEffect(() => {
    fetchDatos()
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [fetchDatos])

  // ─── Handlers ────────────────────────────────────────
  const handleFuenteChange = useCallback((fuente: 'snic' | 'sat') => {
    setFuenteSeleccionada(fuente)
    setProvinciaSeleccionada(null)
    if (fuente === 'sat') {
      setTipoDelitoId(undefined)
    }
    // Limpiar filtros SAT al cambiar fuente
    setFiltrosSAT({})
  }, [])

  const handleProvinciaClick = useCallback((provincia: ProvinciaData) => {
    setProvinciaSeleccionada(provincia)
  }, [])

  const handleProvinciaGeoClick = useCallback((_id: string, nombre: string) => {
    const normalizar = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()

    const match = datos.find(
      d => normalizar(d.provincia) === normalizar(nombre) || d.provinciaId === _id
    )
    if (match) setProvinciaSeleccionada(match)
  }, [datos])

  const handleRecentrar = useCallback(() => {
    if (mapRef.current && geoDisponible) {
      mapRef.current.panTo({ lat: ubicacion.lat, lng: ubicacion.lng })
      mapRef.current.setZoom(ubicacion.zoom)
    }
  }, [ubicacion, geoDisponible])

  // Búsqueda de provincia → volar al centroide SIN abrir panel
  // El usuario toca el marcador o polígono para ver estadísticas
  const [toastProvincia, setToastProvincia] = useState<string | null>(null)

  const handleBuscarProvincia = useCallback((provincia: { provincia: string; provinciaId: string; latitud: number; longitud: number }) => {
    const map = mapRef.current
    if (!map) return

    const destino = { lat: provincia.latitud, lng: provincia.longitud }
    const zoomActual = map.getZoom() ?? 4

    // Si ya estamos en zoom alto, hacer efecto fly: zoom out → pan → zoom in
    // Si estamos en vista nacional, pan directo
    if (zoomActual >= 6) {
      // Paso 1: zoom out para dar contexto del movimiento
      map.setZoom(5)
      // Paso 2: después de la animación de zoom, pan al destino
      setTimeout(() => {
        map.panTo(destino)
        // Paso 3: zoom in al destino
        setTimeout(() => {
          map.setZoom(7)
        }, 400)
      }, 300)
    } else {
      // Vista nacional: pan + zoom directo (el pan se anima naturalmente)
      map.panTo(destino)
      setTimeout(() => {
        map.setZoom(7)
      }, 200)
    }

    setToastProvincia(provincia.provincia)
    setTimeout(() => setToastProvincia(null), 3000)
  }, [])

  // Cerrar panel → zoom cómodo para ver la provincia en contexto
  const handleCerrarPanel = useCallback(() => {
    const prov = provinciaSeleccionada
    setProvinciaSeleccionada(null)
    if (mapRef.current && prov) {
      // Zoom 6 = provincia visible con contexto de vecinas
      mapRef.current.panTo({ lat: prov.latitud, lng: prov.longitud })
      mapRef.current.setZoom(6)
    }
  }, [provinciaSeleccionada])

  // ─── Datos derivados ─────────────────────────────────
  const estadisticasProvincias = datos.map(d => ({
    provinciaId: d.provinciaId,
    provincia: d.provincia,
    totalHechos: d.totalHechos,
  }))

  const totalNacional = datos.reduce((acc, d) => acc + (d.totalHechos || 0), 0)
  const totalVictimas = datos.reduce((acc, d) => acc + (d.totalVictimas || 0), 0)

  // Siempre arranca en vista nacional — geo mueve el mapa cuando llega
  const centroInicial = ARGENTINA_CENTER
  const zoomInicial = ARGENTINA_ZOOM

  return (
    <div className="relative w-full h-screen flex flex-col">
      {/* ─── Barra superior ─────────────────────────────── */}
      <div className="absolute top-4 left-4 right-4 z-10 flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2 sm:px-4 sm:py-3 flex items-center gap-2 sm:gap-4">
          <h1 className="text-sm sm:text-lg font-bold text-[#1E427C]">
            Mapa Nacional del Delito
          </h1>
          <span className="text-xs sm:text-sm text-gray-500 hidden sm:inline">
            Usina de Justicia
          </span>
        </div>

        {/* Selector de fuente SNIC/SAT */}
        <SelectorFuente
          value={fuenteSeleccionada}
          onChange={handleFuenteChange}
        />

        {/* Buscador de provincia */}
        <BuscadorProvincia
          provincias={datos.map(d => ({
            provincia: d.provincia,
            provinciaId: d.provinciaId,
            latitud: d.latitud,
            longitud: d.longitud,
          }))}
          onSeleccionar={handleBuscarProvincia}
        />

        {fuenteSeleccionada === 'snic' && (
          <SelectorDelito
            value={tipoDelitoId}
            onChange={setTipoDelitoId}
          />
        )}

        {/* Filtro departamento — oculto hasta Fase 2
        <div className="hidden sm:block">
          <FiltroDepartamento 
            provinciaId={provinciaSeleccionada?.provinciaId} 
            onChange={setDepartamentoSeleccionado}
            value={departamentoSeleccionado}
          />
        </div>
        */}

        {aniosDisponibles.length > 0 && (
          <SliderAnios
            anios={aniosDisponibles}
            anioSeleccionado={anioSeleccionado}
            onChange={setAnioSeleccionado}
          />
        )}

        {!loading && totalNacional > 0 && (
          <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-3 py-1.5 sm:px-4 sm:py-2 flex items-center gap-3 sm:gap-4 text-xs sm:text-sm">
            <div>
              <span className="text-gray-500">Hechos:</span>{' '}
              <span className="font-bold text-[#1E427C]">
                {totalNacional.toLocaleString('es-AR')}
              </span>
            </div>
            <div className="w-px h-4 sm:h-5 bg-gray-200" />
            <div>
              <span className="text-gray-500">Víctimas:</span>{' '}
              <span className="font-bold text-[#1E427C]">
                {totalVictimas.toLocaleString('es-AR')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ─── Filtros SAT (barra secundaria) ─────────────── */}
      <FiltrosSAT
        filtros={filtrosSAT}
        onChange={setFiltrosSAT}
        visible={fuenteSeleccionada === 'sat'}
      />

      {/* ─── Tooltip hover ──────────────────────────────── */}
      {provinciaHover && (
        <div className="absolute top-16 sm:top-20 left-1/2 -translate-x-1/2 z-10 bg-white/95 backdrop-blur-sm rounded-lg shadow-md px-3 py-1.5 text-sm font-medium text-[#1E427C] pointer-events-none">
          {provinciaHover}
        </div>
      )}

      {/* ─── Toast después de buscar provincia ─────────── */}
      {toastProvincia && (
        <div className="absolute bottom-24 sm:bottom-20 left-1/2 -translate-x-1/2 z-10 bg-[#1E427C] text-white rounded-lg shadow-lg px-4 py-2 text-sm font-medium pointer-events-none animate-pulse">
          Tocá {toastProvincia} para ver estadísticas
        </div>
      )}

      {/* ─── Loading (solo datos, geo no bloquea) ───────── */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#1E427C] font-medium">Cargando datos...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-16 sm:top-20 left-1/2 -translate-x-1/2 z-20 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* ─── Mapa ───────────────────────────────────────── */}
      <div className="flex-1">
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={centroInicial}
            defaultZoom={zoomInicial}
            gestureHandling="greedy"
            disableDefaultUI={false}
            mapTypeControl={false}
            streetViewControl={false}
            fullscreenControl={false}
            styles={MAPA_STYLE_USINA}
            style={{ width: '100%', height: '100%' }}
            onIdle={(e) => {
              // Guardar referencia al mapa para recentrar
              if (e.map && !mapRef.current) {
                mapRef.current = e.map
              }
            }}
          >
            {/* Precarga inteligente de departamentos en background */}
            <PrecargaInteligente />

            {/* Capa 0: Máscara */}
            <MascaraPaises />

            {/* Capa 1: Provincias */}
            <CapaProvincias
              estadisticas={estadisticasProvincias}
              onProvinciaClick={handleProvinciaGeoClick}
              onProvinciaHover={setProvinciaHover}
            />

            {/* Capa 2: Departamentos (lazy loaded) */}
            <CapaDepartamentos
              zoomMinimo={7}
              provinciaIdFiltro={provinciaSeleccionada?.provinciaId ?? null}
              destacados={[QUILMES_DEPTO_ID]}
            />

            {/* Capa 3: Marcadores circulares */}
            <MarcadoresCirculares
              datos={datos}
              onProvinciaClick={handleProvinciaClick}
              filtroActivo={fuenteSeleccionada === 'sat' && Object.values(filtrosSAT).some(v => v !== undefined)}
            />
          </Map>
        </APIProvider>
      </div>

      {/* ─── Panel estadísticas ─────────────────────────── */}
      {provinciaSeleccionada && (
        <PanelEstadisticas
          provincia={provinciaSeleccionada}
          anio={anioSeleccionado}
          fuente={fuenteSeleccionada}
          onClose={handleCerrarPanel}
        />
      )}

      {/* ─── Botón recentrar ────────────────────────────── */}
      <BotonRecentrar
        disponible={geoDisponible}
        onClick={handleRecentrar}
      />

      {/* ─── Leyenda ────────────────────────────────────── */}
      <div className="absolute bottom-6 left-4 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2 sm:px-4 sm:py-3 z-10 max-w-[200px] sm:max-w-xs">
        <p className="text-[10px] sm:text-xs font-semibold text-gray-700 mb-1.5 sm:mb-2">Intensidad por provincia</p>
        <div className="flex items-center gap-0.5">
          {['#C5D1E4', '#9BB1CF', '#4A71A5', '#1E427C', '#15305B', '#0E2240', '#091729'].map(
            (color, i) => (
              <div
                key={i}
                className="w-5 sm:w-6 h-2.5 sm:h-3 first:rounded-l-sm last:rounded-r-sm"
                style={{ backgroundColor: color }}
              />
            )
          )}
        </div>
        <div className="flex justify-between mt-1 text-[9px] sm:text-[10px] text-gray-400">
          <span>Menor</span>
          <span>Mayor</span>
        </div>

        <div className="mt-2 sm:mt-3 pt-1.5 sm:pt-2 border-t border-gray-100 space-y-1">
          <div className="flex items-center gap-2 text-[9px] sm:text-[10px] text-gray-500">
            <div className="w-3 h-2 rounded-sm border border-red-500 bg-red-500/15 shrink-0" />
            Caso registrado (medios)
          </div>
        </div>

        <p className="text-[8px] sm:text-[10px] text-gray-400 mt-2 sm:mt-3">
          Fuente: {fuenteSeleccionada === 'snic' ? 'SNIC — Min. de Seguridad' : 'SAT — Homicidios dolosos'} · {anioSeleccionado}
        </p>
        <div className="flex gap-2 mt-1.5">
          <a
            href="/metodologia"
            className="text-[8px] sm:text-[9px] text-gray-400 hover:text-gray-600 underline"
          >
            Metodología
          </a>
          <a
            href="/admin/revisiones"
            className="text-[8px] sm:text-[9px] text-gray-400 hover:text-gray-600 underline"
          >
            Revisión
          </a>
        </div>
      </div>
    </div>
  )
}
