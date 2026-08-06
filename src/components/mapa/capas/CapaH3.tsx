'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { contenidoCeldaH3 } from '@/lib/mapa/infowindow-dom'
import { useMap } from '@vis.gl/react-google-maps'
import { cellToBoundary } from 'h3-js'
import { useH3Density, getH3Resolution } from '@/hooks/useH3Density'

const H3_COLORS = [
  'rgba(197, 209, 228, 0.4)',
  'rgba(155, 177, 207, 0.5)',
  'rgba(74, 113, 165, 0.55)',
  'rgba(30, 66, 124, 0.6)',
  'rgba(21, 48, 91, 0.65)',
  'rgba(14, 34, 64, 0.7)',
  'rgba(9, 23, 41, 0.75)',
]

function getColor(count: number, maxCount: number): string {
  if (maxCount === 0) return H3_COLORS[0]
  const ratio = count / maxCount
  const index = Math.min(Math.floor(ratio * H3_COLORS.length), H3_COLORS.length - 1)
  return H3_COLORS[index]
}

interface Props {
  anio: number
  visible: boolean
  fuente: 'snic' | 'sat'
}

export function CapaH3({ anio, visible, fuente }: Props) {
  const map = useMap()
  const polygonsRef = useRef<google.maps.Polygon[]>([])
  const infoRef = useRef<google.maps.InfoWindow | null>(null)
  const [zoom, setZoom] = useState(4)
  const resolution = getH3Resolution(zoom)

  const enabled = visible && fuente === 'sat'
  const { cells, maxCount } = useH3Density(
    enabled ? anio : null,
    resolution,
    enabled
  )

  useEffect(() => {
    if (!map) return
    const listener = map.addListener('zoom_changed', () => {
      setZoom(map.getZoom() ?? 4)
    })
    setZoom(map.getZoom() ?? 4)
    return () => google.maps.event.removeListener(listener)
  }, [map])

  const clearPolygons = useCallback(() => {
    for (const p of polygonsRef.current) {
      p.setMap(null)
    }
    polygonsRef.current = []
    if (infoRef.current) {
      infoRef.current.close()
    }
  }, [])

  useEffect(() => {
    if (!map) return
    clearPolygons()

    if (!visible || cells.length === 0) return

    if (!infoRef.current) {
      infoRef.current = new google.maps.InfoWindow()
    }

    const newPolygons: google.maps.Polygon[] = []

    for (const cell of cells) {
      const boundary = cellToBoundary(cell.h3Index)
      const paths = boundary.map(([lat, lng]) => ({ lat, lng }))

      const polygon = new google.maps.Polygon({
        paths,
        strokeColor: '#1E427C',
        strokeOpacity: 0.3,
        strokeWeight: 1,
        fillColor: getColor(cell.count, maxCount),
        fillOpacity: 0.6,
        map,
        zIndex: 2,
      })

      polygon.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!infoRef.current || !e.latLng) return
        infoRef.current.setContent(
          contenidoCeldaH3({
            count: cell.count,
            victimas: cell.victimas,
            victimasParcial: cell.victimasParcial,
          })
        )
        infoRef.current.setPosition(e.latLng)
        infoRef.current.open(map)
      })

      newPolygons.push(polygon)
    }

    polygonsRef.current = newPolygons

    return () => {
      clearPolygons()
    }
  }, [map, cells, maxCount, visible, clearPolygons])

  useEffect(() => {
    return () => {
      clearPolygons()
    }
  }, [clearPolygons])

  return null
}
