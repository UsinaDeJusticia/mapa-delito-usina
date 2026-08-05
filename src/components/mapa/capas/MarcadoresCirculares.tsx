'use client'

import { useEffect, useRef } from 'react'
import { contenidoProvincia } from '@/lib/mapa/infowindow-dom'
import { useMap } from '@vis.gl/react-google-maps'

const USINA_AZUL = '#1E427C'
const USINA_NARANJA = '#D85A30'

interface ProvinciaData {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
  totalHechos: number
  totalVictimas: number
  delitos: Array<{ nombre: string; hechos: number; victimas: number }>
}

function getColor(ratio: number, filtrado: boolean = false): string {
  if (!filtrado) {
    if (ratio < 0.12) return '#C5D1E4'
    if (ratio < 0.25) return '#9BB1CF'
    if (ratio < 0.40) return '#4A71A5'
    if (ratio < 0.55) return USINA_AZUL
    if (ratio < 0.70) return '#15305B'
    if (ratio < 0.85) return '#0E2240'
    return '#091729'
  }
  if (ratio < 0.12) return '#FAECE7'
  if (ratio < 0.25) return '#F5C4B3'
  if (ratio < 0.40) return '#F0997B'
  if (ratio < 0.55) return USINA_NARANJA
  if (ratio < 0.70) return '#993C1D'
  if (ratio < 0.85) return '#712B13'
  return '#4A1B0C'
}

function crearIconoSVG(hechos: number, maxHechos: number, filtrado: boolean = false): { url: string; size: number } {
  const ratio = maxHechos > 0 ? hechos / maxHechos : 0
  const color = getColor(ratio, filtrado)

  const size = Math.round(22 + ratio * 32)
  const half = size / 2
  const fontSize = Math.max(9, Math.round(size / 3.5))

  const texto = hechos > 9999
    ? `${Math.round(hechos / 1000)}k`
    : hechos > 999
    ? `${(hechos / 1000).toFixed(1)}k`
    : `${hechos}`

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${half}" cy="${half}" r="${half - 1.5}" fill="${color}" stroke="rgba(255,255,255,0.85)" stroke-width="2"/>
  <text x="${half}" y="${half}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="system-ui,-apple-system,sans-serif" font-size="${fontSize}" font-weight="600">${texto}</text>
</svg>`

  return {
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    size,
  }
}

interface Props {
  datos: ProvinciaData[]
  onProvinciaClick: (provincia: ProvinciaData) => void
  filtroActivo?: boolean
}

export function MarcadoresCirculares({ datos, onProvinciaClick, filtroActivo = false }: Props) {
  const map = useMap()
  const markersRef = useRef<google.maps.Marker[]>([])
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)

  useEffect(() => {
    if (!map || datos.length === 0) return

    markersRef.current.forEach(m => m.setMap(null))
    markersRef.current = []
    infoWindowRef.current?.close()

    const infoWindow = new google.maps.InfoWindow()
    infoWindowRef.current = infoWindow

    const datosValidos = datos.filter(d => d.latitud && d.longitud && d.totalHechos != null)
    const maxHechos = Math.max(...datosValidos.map(d => d.totalHechos || 0), 1)

    datosValidos.forEach(provincia => {
      const { url, size } = crearIconoSVG(provincia.totalHechos || 0, maxHechos, filtroActivo)

      const marker = new google.maps.Marker({
        position: { lat: provincia.latitud, lng: provincia.longitud },
        map,
        icon: {
          url,
          scaledSize: new google.maps.Size(size, size),
          anchor: new google.maps.Point(size / 2, size / 2),
        },
        title: provincia.provincia,
        zIndex: 10 + Math.round(((provincia.totalHechos || 0) / maxHechos) * 100),
        optimized: false,
      })

      marker.addListener('mouseover', () => {
        // Contenido como nodos DOM: el nombre de provincia y los nombres de
        // delito salen de la base y setContent(string) los trataría como HTML.
        infoWindow.setContent(
          contenidoProvincia({
            provincia: provincia.provincia,
            totalHechos: provincia.totalHechos,
            totalVictimas: provincia.totalVictimas,
            delitos: provincia.delitos,
          })
        )
        infoWindow.open(map, marker)
      })

      marker.addListener('mouseout', () => {
        infoWindow.close()
      })

      marker.addListener('click', () => {
        onProvinciaClick(provincia)
      })

      markersRef.current.push(marker)
    })

    return () => {
      markersRef.current.forEach(m => m.setMap(null))
      markersRef.current = []
      infoWindow.close()
    }
  }, [map, datos, onProvinciaClick, filtroActivo])

  return null
}
