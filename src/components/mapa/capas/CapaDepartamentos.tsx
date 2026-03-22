'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { useGeoJSON } from '../hooks/useGeoJSON'
import type { FeatureCollection } from 'geojson'

const USINA_AZUL = '#1E427C'
const USINA_ROJO = '#DC2626'

interface Props {
  zoomMinimo?: number
  provinciaIdFiltro?: string | null
  destacados?: string[]
  onDepartamentoClick?: (deptoId: string, nombre: string, provinciaId: string) => void
}

// Máximo de labels simultáneos para no matar performance en mobile
const MAX_LABELS = 80

export function CapaDepartamentos({
  zoomMinimo = 7,
  provinciaIdFiltro = null,
  destacados = [],
  onDepartamentoClick,
}: Props) {
  const map = useMap()

  // Lazy load: cargar GeoJSON solo cuando zoom >= zoomMinimo - 1 (anticipar 1 nivel)
  // o cuando hay provincia seleccionada
  const [necesitaGeoJSON, setNecesitaGeoJSON] = useState(!!provinciaIdFiltro)
  const { data: geojson } = useGeoJSON('departamentos-poligonos.geojson', necesitaGeoJSON)

  const dataLayerRef = useRef<google.maps.Data | null>(null)
  const labelsRef = useRef<google.maps.Marker[]>([])
  const zoomRef = useRef<number>(4)
  const destacadosSet = useRef(new Set(destacados))

  useEffect(() => {
    destacadosSet.current = new Set(destacados)
  }, [destacados])

  // Activar carga de GeoJSON cuando se acerca al zoom
  useEffect(() => {
    if (!map || necesitaGeoJSON) return

    const listener = map.addListener('zoom_changed', () => {
      const zoom = map.getZoom() ?? 4
      if (zoom >= zoomMinimo - 1) {
        setNecesitaGeoJSON(true)
      }
    })

    return () => google.maps.event.removeListener(listener)
  }, [map, zoomMinimo, necesitaGeoJSON])

  // Si hay provincia seleccionada, forzar carga
  useEffect(() => {
    if (provinciaIdFiltro) setNecesitaGeoJSON(true)
  }, [provinciaIdFiltro])

  // Aplicar estilos dinámicos según zoom
  const aplicarEstilos = useCallback(() => {
    if (!dataLayerRef.current) return
    const zoom = zoomRef.current
    const ds = destacadosSet.current

    dataLayerRef.current.setStyle((feature) => {
      const id = feature.getProperty('id') as string
      const esDestacado = ds.has(id)

      if (esDestacado) {
        return {
          strokeColor: USINA_ROJO,
          strokeWeight: zoom >= zoomMinimo ? 2.5 : 1.5,
          strokeOpacity: 0.9,
          fillColor: USINA_ROJO,
          fillOpacity: zoom >= zoomMinimo ? 0.18 : 0.12,
          zIndex: 5,
        }
      }

      if (zoom < zoomMinimo) {
        return {
          strokeWeight: 0,
          strokeOpacity: 0,
          fillOpacity: 0,
          clickable: false,
          zIndex: 2,
        }
      }

      const intensity = Math.min(1, (zoom - zoomMinimo) / 4)
      return {
        strokeColor: USINA_AZUL,
        strokeWeight: 0.4 + intensity * 0.8,
        strokeOpacity: 0.25 + intensity * 0.35,
        fillColor: 'transparent',
        fillOpacity: 0,
        clickable: true,
        zIndex: 2,
      }
    })
  }, [zoomMinimo])

  // Labels optimizados: máximo MAX_LABELS, solo en viewport
  const actualizarLabels = useCallback(() => {
    if (!map || !geojson) return

    labelsRef.current.forEach(m => m.setMap(null))
    labelsRef.current = []

    const zoom = zoomRef.current
    if (zoom < zoomMinimo + 1) return

    const bounds = map.getBounds()
    if (!bounds) return

    const ds = destacadosSet.current
    const fontSize = zoom >= 11 ? 11 : zoom >= 9 ? 10 : 9

    // Filtrar features en viewport + destacados
    const enViewport: Array<{ props: Record<string, any>; esDestacado: boolean }> = []

    for (const feature of geojson.features) {
      const props = feature.properties
      if (!props?.centroide) continue

      const { lat, lon } = props.centroide
      if (!lat || !lon) continue

      // Filtro por provincia si aplica
      if (provinciaIdFiltro) {
        const prov = props.provincia
        const provId = typeof prov === 'object' && prov !== null ? prov.id : prov
        if (provId !== provinciaIdFiltro) continue
      }

      const esDestacado = ds.has(props.id)
      const enBounds = bounds.contains({ lat, lng: lon })

      if (enBounds || esDestacado) {
        enViewport.push({ props, esDestacado })
      }

      // Cortar si ya tenemos suficientes
      if (enViewport.length >= MAX_LABELS) break
    }

    // Crear labels
    for (const { props, esDestacado } of enViewport) {
      const marker = new google.maps.Marker({
        position: { lat: props.centroide.lat, lng: props.centroide.lon },
        map,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 },
        label: {
          text: props.nombre as string,
          color: esDestacado ? USINA_ROJO : USINA_AZUL,
          fontSize: `${fontSize}px`,
          fontWeight: esDestacado ? '700' : '500',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        },
        clickable: false,
        zIndex: esDestacado ? 8 : 4,
        optimized: true,
      })
      labelsRef.current.push(marker)
    }
  }, [map, geojson, zoomMinimo, provinciaIdFiltro])

  // Setup principal
  useEffect(() => {
    if (!map || !geojson) return

    const dataLayer = new google.maps.Data({ map })
    dataLayerRef.current = dataLayer

    if (provinciaIdFiltro) {
      const filtered: FeatureCollection = {
        type: 'FeatureCollection',
        features: geojson.features.filter(f => {
          const prov = f.properties?.provincia
          const provId = typeof prov === 'object' && prov !== null ? prov.id : prov
          return provId === provinciaIdFiltro
        }),
      }
      dataLayer.addGeoJson(filtered)
    } else {
      dataLayer.addGeoJson(geojson)
    }

    zoomRef.current = map.getZoom() ?? 4
    aplicarEstilos()
    actualizarLabels()

    const zoomListener = map.addListener('zoom_changed', () => {
      zoomRef.current = map.getZoom() ?? 4
      aplicarEstilos()
      actualizarLabels()
    })

    const idleListener = map.addListener('idle', actualizarLabels)

    // Hover
    dataLayer.addListener('mouseover', (event: google.maps.Data.MouseEvent) => {
      const id = event.feature.getProperty('id') as string
      const nombre = event.feature.getProperty('nombre') as string
      const esDestacado = destacadosSet.current.has(id)

      dataLayer.overrideStyle(event.feature, {
        strokeWeight: esDestacado ? 3 : 2,
        strokeOpacity: 0.85,
        fillColor: esDestacado ? USINA_ROJO : USINA_AZUL,
        fillOpacity: esDestacado ? 0.25 : 0.10,
      })
      map.getDiv().title = nombre
    })

    dataLayer.addListener('mouseout', (event: google.maps.Data.MouseEvent) => {
      dataLayer.revertStyle(event.feature)
      map.getDiv().title = ''
    })

    if (onDepartamentoClick) {
      dataLayer.addListener('click', (event: google.maps.Data.MouseEvent) => {
        const id = event.feature.getProperty('id') as string
        const nombre = event.feature.getProperty('nombre') as string
        const prov = event.feature.getProperty('provincia') as { id: string } | string
        const provId = typeof prov === 'object' ? prov.id : (prov || '')
        onDepartamentoClick(id, nombre, provId)
      })
    }

    return () => {
      dataLayer.setMap(null)
      dataLayerRef.current = null
      google.maps.event.removeListener(zoomListener)
      google.maps.event.removeListener(idleListener)
      labelsRef.current.forEach(m => m.setMap(null))
      labelsRef.current = []
    }
  }, [map, geojson, provinciaIdFiltro, aplicarEstilos, actualizarLabels, onDepartamentoClick])

  return null
}

