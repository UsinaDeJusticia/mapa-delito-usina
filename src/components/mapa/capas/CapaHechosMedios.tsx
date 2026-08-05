'use client'

import { useEffect, useRef } from 'react'
import { contenidoHechoMedio } from '@/lib/mapa/infowindow-dom'
import { useMap } from '@vis.gl/react-google-maps'

export interface HechoMedio {
  id: string
  titulo: string | null
  medio: string | null
  url_cobertura: string | null
  provincia: string | null
  ciudad: string | null
  latitud: number
  longitud: number
  fecha_hecho: string | null
  confianza: string
  tipo_delito: string | null
}

const COLOR_VERIFICADO = '#C0392B'
const COLOR_PRELIMINAR = '#E67E22'

function crearPinSVG(confianza: string): string {
  const esVerificado = confianza === 'VERIFICADO'
  const color = esVerificado ? COLOR_VERIFICADO : COLOR_PRELIMINAR
  const opacity = esVerificado ? '1' : '0.75'

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="26" viewBox="0 0 20 26">
    <path d="M10 0C4.48 0 0 4.48 0 10c0 7.5 10 16 10 16s10-8.5 10-16C20 4.48 15.52 0 10 0z"
      fill="${color}" opacity="${opacity}" stroke="white" stroke-width="1.5"/>
    <circle cx="10" cy="10" r="4" fill="white" opacity="0.9"/>
  </svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

interface Props {
  hechos: HechoMedio[]
  visible: boolean
}

export function CapaHechosMedios({ hechos, visible }: Props) {
  const map = useMap()
  const markersRef = useRef<google.maps.Marker[]>([])
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null)

  useEffect(() => {
    if (!map) return

    // Limpiar marcadores anteriores
    markersRef.current.forEach(m => m.setMap(null))
    markersRef.current = []
    infoWindowRef.current?.close()

    if (!visible || hechos.length === 0) return

    const infoWindow = new google.maps.InfoWindow()
    infoWindowRef.current = infoWindow

    hechos.forEach(hecho => {
      const esVerificado = hecho.confianza === 'VERIFICADO'
      const iconUrl = crearPinSVG(hecho.confianza)

      const marker = new google.maps.Marker({
        position: { lat: hecho.latitud, lng: hecho.longitud },
        map,
        icon: {
          url: iconUrl,
          scaledSize: new google.maps.Size(20, 26),
          anchor: new google.maps.Point(10, 26),
        },
        title: hecho.titulo ?? 'Hecho sin título',
        zIndex: esVerificado ? 200 : 100,
        optimized: false,
      })

      marker.addListener('click', () => {
        const fecha = hecho.fecha_hecho
          ? new Date(hecho.fecha_hecho).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' })
          : 'Fecha desconocida'

        // Contenido como nodos DOM: título, medio, ubicación y URL vienen de
        // scraping, y setContent(string) los interpretaría como HTML.
        infoWindow.setContent(
          contenidoHechoMedio({
            titulo: hecho.titulo,
            medio: hecho.medio,
            ciudad: hecho.ciudad,
            provincia: hecho.provincia,
            tipo_delito: hecho.tipo_delito,
            url_cobertura: hecho.url_cobertura,
            fecha,
            esVerificado,
          })
        )
        infoWindow.open(map, marker)
      })

      markersRef.current.push(marker)
    })

    return () => {
      markersRef.current.forEach(m => m.setMap(null))
      markersRef.current = []
      infoWindow.close()
    }
  }, [map, hechos, visible])

  return null
}
