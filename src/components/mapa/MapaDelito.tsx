'use client'

import { useState, useEffect, useCallback } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import { PanelEstadisticas } from './PanelEstadisticas'
import { SliderAnios } from './SliderAnios'
import { SelectorDelito } from './SelectorDelito'
import { MAPA_STYLE_USINA } from '@/config/mapStyles'

// Tipos
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

// Centro de Argentina
const ARGENTINA_CENTER = { lat: -38.4161, lng: -63.6167 }
const ARGENTINA_ZOOM = 4

// Paleta de colores Usina (violeta → rojo por intensidad)
function getColorByRate(hechos: number, maxHechos: number): string {
  if (maxHechos === 0) return '#C5D1E4'
  const ratio = hechos / maxHechos
  if (ratio < 0.15) return '#C5D1E4'
  if (ratio < 0.30) return '#9BB1CF'
  if (ratio < 0.45) return '#4A71A5'
  if (ratio < 0.60) return '#1E427C'
  if (ratio < 0.75) return '#15305B'
  if (ratio < 0.90) return '#DC2626'
  return '#991B1B'
}

// Componente interno que accede al mapa
function MapaContenido({
  datos,
  provinciaSeleccionada,
  onProvinciaClick,
}: {
  datos: ProvinciaData[]
  provinciaSeleccionada: string | null
  onProvinciaClick: (provincia: ProvinciaData | null) => void
}) {
  const map = useMap()

  useEffect(() => {
    if (!map || datos.length === 0) return

    map.setOptions({ styles: MAPA_STYLE_USINA })
    console.log('Estilos aplicados:', MAPA_STYLE_USINA.length, 'reglas')

    // Filtrar datos válidos
    const datosValidos = datos.filter(d => d && d.totalHechos !== undefined && d.totalHechos != null)
    if (datosValidos.length === 0) return

    // Limpiar marcadores anteriores
    const markers: google.maps.Marker[] = []
    const maxHechos = Math.max(...datosValidos.map(d => d.totalHechos || 0))

    datosValidos.forEach(provincia => {
      if (!provincia.latitud || !provincia.longitud) return
      
      const totalHechos = provincia.totalHechos || 0
      const color = getColorByRate(totalHechos, maxHechos)

      // Crear marcador circular con tamaño proporcional
      const size = Math.max(20, Math.min(60, maxHechos > 0 ? (totalHechos / maxHechos) * 60 : 30))

      const markerContent = document.createElement('div')
      markerContent.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: ${color};
        border: 2px solid rgba(255,255,255,0.8);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${Math.max(9, size / 4)}px;
        font-weight: 600;
        color: white;
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        transition: transform 0.2s;
      `
      markerContent.textContent = totalHechos > 999
        ? `${Math.round(totalHechos / 1000)}k`
        : `${totalHechos}`

      markerContent.addEventListener('mouseenter', () => {
        markerContent.style.transform = 'scale(1.2)'
      })
      markerContent.addEventListener('mouseleave', () => {
        markerContent.style.transform = 'scale(1)'
      })

      const marker = new google.maps.Marker({
        position: { lat: provincia.latitud, lng: provincia.longitud },
        map,
        title: `${provincia.provincia}: ${totalHechos.toLocaleString('es-AR')} hechos`,
      })

      marker.addListener('click', () => {
        onProvinciaClick(provincia)
      })

      markers.push(marker)
    })

    return () => {
      markers.forEach(m => m.setMap(null))
    }
  }, [map, datos, onProvinciaClick])

  return null
}

// Componente principal exportado
export default function MapaDelito() {
  const [anioSeleccionado, setAnioSeleccionado] = useState(2024)
  const [aniosDisponibles, setAniosDisponibles] = useState<number[]>([])
  const [datos, setDatos] = useState<ProvinciaData[]>([])
  const [provinciaSeleccionada, setProvinciaSeleccionada] = useState<ProvinciaData | null>(null)
  const [tipoDelitoId, setTipoDelitoId] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || ''

  // Fetch datos del mapa
  const fetchDatos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ anio: anioSeleccionado.toString() })
      if (tipoDelitoId) params.set('tipo_delito_id', tipoDelitoId)

      const res = await fetch(`/api/mapa/estadisticas?${params}`)
      if (!res.ok) throw new Error('Error al cargar datos')

      const data: EstadisticasResponse = await res.json()
      setDatos(data.provincias)
      setAniosDisponibles(data.aniosDisponibles)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }, [anioSeleccionado, tipoDelitoId])

  useEffect(() => {
    fetchDatos()
  }, [fetchDatos])

  const handleProvinciaClick = useCallback((provincia: ProvinciaData | null) => {
    setProvinciaSeleccionada(provincia)
  }, [])

  return (
    <div className="relative w-full h-screen flex flex-col">
      {/* Barra superior con controles */}
      <div className="absolute top-4 left-4 right-4 z-10 flex flex-wrap items-center gap-3">
        <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-3 flex items-center gap-4">
          <h1 className="text-lg font-bold text-usina-900">
            Mapa Nacional del Delito
          </h1>
          <span className="text-sm text-gray-500">
            Usina de Justicia
          </span>
        </div>

        <SelectorDelito
          value={tipoDelitoId}
          onChange={setTipoDelitoId}
        />

        {aniosDisponibles.length > 0 && (
          <SliderAnios
            anios={aniosDisponibles}
            anioSeleccionado={anioSeleccionado}
            onChange={setAnioSeleccionado}
          />
        )}
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-usina-900 border-t-transparent rounded-full animate-spin" />
            <p className="text-usina-900 font-medium">Cargando datos...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* Mapa */}
      <div className="flex-1">
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={ARGENTINA_CENTER}
            defaultZoom={ARGENTINA_ZOOM}
            gestureHandling="greedy"
            disableDefaultUI={false}
            mapTypeControl={false}
            streetViewControl={false}
            style={{ width: '100%', height: '100%' }}
          >
            <MapaContenido
              datos={datos}
              provinciaSeleccionada={provinciaSeleccionada?.provincia || null}
              onProvinciaClick={handleProvinciaClick}
            />
          </Map>
        </APIProvider>
      </div>

      {/* Panel lateral de estadísticas */}
      {provinciaSeleccionada && (
        <PanelEstadisticas
          provincia={provinciaSeleccionada}
          anio={anioSeleccionado}
          onClose={() => setProvinciaSeleccionada(null)}
        />
      )}

      {/* Leyenda */}
      <div className="absolute bottom-6 left-4 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-3 z-10">
        <p className="text-xs font-medium text-gray-600 mb-2">Hechos registrados</p>
        <div className="flex items-center gap-1">
          {['#C5D1E4', '#9BB1CF', '#4A71A5', '#1E427C', '#15305B', '#B91C1C', '#991B1B'].map((color, i) => (
            <div key={i} className="w-5 h-3 rounded-sm" style={{ backgroundColor: color }} />
          ))}
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-gray-400">Menor</span>
          <span className="text-[10px] text-gray-400">Mayor</span>
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          Fuente: SNIC — Ministerio de Seguridad · {anioSeleccionado}
        </p>
      </div>
    </div>
  )
}