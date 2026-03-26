'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { useGeoJSON } from '../hooks/useGeoJSON'

const USINA_AZUL = '#1E427C'
const USINA_AZUL_CLARO = '#4A71A5'

interface ProvinciaStats {
  provinciaId: string
  provincia: string
  totalHechos: number
}

function normalizar(nombre: string): string {
  return nombre
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ciudad autonoma de buenos aires/g, 'caba')
    .replace(/tierra del fuego.*$/g, 'tierra del fuego')
    .trim()
}

/**
 * Opacidad del relleno según hechos Y zoom.
 * 
 * A zoom bajo (4-6): opacidad normal para que el coroplético se vea bien.
 * A zoom alto (7+): reduce progresivamente para que los labels de
 * Google Maps (ciudades, rutas, accidentes geográficos) se lean.
 */
function getFillOpacity(hechos: number, maxHechos: number, zoom: number): number {
  if (maxHechos === 0 || hechos === 0) return 0.03

  const ratio = hechos / maxHechos
  // Opacidad base por intensidad de hechos
  const baseOpacity = 0.04 + ratio * 0.45 // rango 0.04 → 0.49 (reducido de 0.60)

  // Factor de reducción por zoom
  // zoom 4-6: factor 1.0 (sin reducción)
  // zoom 7-8: factor 0.6
  // zoom 9+: factor 0.3
  let zoomFactor = 1.0
  if (zoom >= 9) {
    zoomFactor = 0.3
  } else if (zoom >= 7) {
    zoomFactor = 0.6
  }

  return baseOpacity * zoomFactor
}

interface Props {
  estadisticas: ProvinciaStats[]
  onProvinciaClick?: (provinciaId: string, nombre: string) => void
  onProvinciaHover?: (nombre: string | null) => void
}

export function CapaProvincias({ estadisticas, onProvinciaClick, onProvinciaHover }: Props) {
  const map = useMap()
  const { data: geojson } = useGeoJSON('provincias-poligonos.geojson')
  const dataLayerRef = useRef<google.maps.Data | null>(null)
  const zoomRef = useRef<number>(4)

  // Mapa de stats para lookup rápido
  const statsMapRef = useRef(new Map<string, ProvinciaStats>())
  const statsByIdRef = useRef(new Map<string, ProvinciaStats>())
  const maxHechosRef = useRef(1)

  useEffect(() => {
    const byName = new Map<string, ProvinciaStats>()
    const byId = new Map<string, ProvinciaStats>()
    estadisticas.forEach(e => {
      byName.set(normalizar(e.provincia), e)
      byId.set(e.provinciaId, e)
    })
    statsMapRef.current = byName
    statsByIdRef.current = byId
    maxHechosRef.current = Math.max(...estadisticas.map(e => e.totalHechos), 1)
  }, [estadisticas])

  // Función que aplica estilos (llamada en mount y en cada zoom)
  const aplicarEstilos = useCallback(() => {
    if (!dataLayerRef.current) return
    const zoom = zoomRef.current
    const maxHechos = maxHechosRef.current
    const statsById = statsByIdRef.current
    const statsMap = statsMapRef.current

    dataLayerRef.current.setStyle((feature) => {
      const nombre = feature.getProperty('nombre') as string || ''
      const id = feature.getProperty('id') as string || ''
      const stats = statsById.get(id) || statsMap.get(normalizar(nombre))
      const hechos = stats?.totalHechos ?? 0

      return {
        strokeColor: USINA_AZUL,
        strokeWeight: zoom >= 8 ? 1.0 : 1.5, // Bordes más finos en zoom alto
        strokeOpacity: zoom >= 9 ? 0.5 : 0.85,
        fillColor: USINA_AZUL,
        fillOpacity: getFillOpacity(hechos, maxHechos, zoom),
        zIndex: 1,
      }
    })
  }, [])

  useEffect(() => {
    if (!map || !geojson) return

    const dataLayer = new google.maps.Data({ map })
    dataLayerRef.current = dataLayer
    dataLayer.addGeoJson(geojson)

    zoomRef.current = map.getZoom() ?? 4
    aplicarEstilos()

    // Re-aplicar estilos cuando cambia el zoom
    const zoomListener = map.addListener('zoom_changed', () => {
      zoomRef.current = map.getZoom() ?? 4
      aplicarEstilos()
    })

    // Hover
    dataLayer.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
      const nombre = event.feature.getProperty('nombre') as string
      const id = event.feature.getProperty('id') as string
      const stats = statsByIdRef.current.get(id) || statsMapRef.current.get(normalizar(nombre))
      const hechos = stats?.totalHechos ?? 0
      const zoom = zoomRef.current

      dataLayer.overrideStyle(event.feature, {
        strokeWeight: 2.5,
        strokeColor: USINA_AZUL_CLARO,
        fillOpacity: Math.min(0.50, getFillOpacity(hechos, maxHechosRef.current, zoom) + 0.12),
      })
      onProvinciaHover?.(nombre)
    })

    dataLayer.addListener('mouseout', (event: google.maps.Data.MouseEvent) => {
      dataLayer.revertStyle(event.feature)
      onProvinciaHover?.(null)
    })

    dataLayer.addListener('click', (event: google.maps.Data.MouseEvent) => {
      const nombre = event.feature.getProperty('nombre') as string
      const id = event.feature.getProperty('id') as string
      onProvinciaClick?.(id, nombre)
    })

    return () => {
      dataLayer.setMap(null)
      dataLayerRef.current = null
      google.maps.event.removeListener(zoomListener)
    }
  }, [map, geojson, aplicarEstilos, onProvinciaClick, onProvinciaHover])

  // Re-aplicar estilos cuando cambian las estadísticas
  useEffect(() => {
    aplicarEstilos()
  }, [estadisticas, aplicarEstilos])

  return null
}
