'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { useGeoJSON } from '../hooks/useGeoJSON'
import type { FeatureCollection } from 'geojson'

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

function getFillOpacity(hechos: number, maxHechos: number): number {
  if (maxHechos === 0 || hechos === 0) return 0.04
  const ratio = hechos / maxHechos
  return 0.04 + ratio * 0.56
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

  useEffect(() => {
    if (!map || !geojson) return

    const dataLayer = new google.maps.Data({ map })
    dataLayerRef.current = dataLayer

    dataLayer.addGeoJson(geojson)

    const maxHechos = Math.max(...estadisticas.map(e => e.totalHechos), 1)

    const statsMap = new Map<string, ProvinciaStats>()
    const statsById = new Map<string, ProvinciaStats>()
    estadisticas.forEach(e => {
      statsMap.set(normalizar(e.provincia), e)
      statsById.set(e.provinciaId, e)
    })

    dataLayer.setStyle((feature) => {
      const nombre = feature.getProperty('nombre') as string || ''
      const id = feature.getProperty('id') as string || ''

      const stats = statsById.get(id) || statsMap.get(normalizar(nombre))
      const hechos = stats?.totalHechos ?? 0

      return {
        strokeColor: USINA_AZUL,
        strokeWeight: 1.5,
        strokeOpacity: 0.85,
        fillColor: USINA_AZUL,
        fillOpacity: getFillOpacity(hechos, maxHechos),
        zIndex: 1,
      }
    })

    dataLayer.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
      const nombre = event.feature.getProperty('nombre') as string
      const id = event.feature.getProperty('id') as string
      const stats = statsById.get(id) || statsMap.get(normalizar(nombre))
      const hechos = stats?.totalHechos ?? 0

      dataLayer.overrideStyle(event.feature, {
        strokeWeight: 2.5,
        strokeColor: USINA_AZUL_CLARO,
        fillOpacity: Math.min(0.70, getFillOpacity(hechos, maxHechos) + 0.15),
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
    }
  }, [map, geojson, estadisticas, onProvinciaClick, onProvinciaHover])

  return null
}
