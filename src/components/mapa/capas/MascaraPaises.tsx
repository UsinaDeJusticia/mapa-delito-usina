'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { useGeoJSON } from '../hooks/useGeoJSON'
import type { FeatureCollection } from 'geojson'

/**
 * Máscara que oculta países vecinos.
 * Polígono mundial con agujeros en cada provincia argentina.
 * Opacidad alta (0.93) para que no se vean labels ni bordes de vecinos.
 */

const WORLD_BOUNDS: google.maps.LatLngLiteral[] = [
  { lat: -85, lng: -180 },
  { lat: 85, lng: -180 },
  { lat: 85, lng: 180 },
  { lat: -85, lng: 180 },
]

function extraerPaths(geojson: FeatureCollection): google.maps.LatLngLiteral[][] {
  const paths: google.maps.LatLngLiteral[][] = []
  for (const feature of geojson.features) {
    const geom = feature.geometry
    if (geom.type === 'Polygon') {
      paths.push(geom.coordinates[0].map(([lng, lat]) => ({ lat, lng })))
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        paths.push(polygon[0].map(([lng, lat]) => ({ lat, lng })))
      }
    }
  }
  return paths
}

export function MascaraPaises() {
  const map = useMap()
  const { data: geojson } = useGeoJSON('provincias-poligonos.geojson')
  const polygonRef = useRef<google.maps.Polygon | null>(null)

  useEffect(() => {
    if (!map || !geojson) return

    const argPaths = extraerPaths(geojson)
    if (argPaths.length === 0) return

    // Opacidad 0.93: suficiente para ocultar labels, bordes y colores de vecinos
    const mascara = new google.maps.Polygon({
      paths: [WORLD_BOUNDS, ...argPaths],
      fillColor: '#DDE3EA',
      fillOpacity: 0.93,
      strokeWeight: 0,
      clickable: false,
      zIndex: 0,
      map,
    })

    polygonRef.current = mascara

    return () => {
      mascara.setMap(null)
      polygonRef.current = null
    }
  }, [map, geojson])

  return null
}