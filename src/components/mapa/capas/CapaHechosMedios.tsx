'use client'

import { useEffect, useRef } from 'react'
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

        const badgeColor = esVerificado ? '#15803D' : '#92400E'
        const badgeBg = esVerificado ? '#DCFCE7' : '#FEF3C7'
        const badgeLabel = esVerificado ? '✓ Verificado' : '⏳ Preliminar'

        const linkHtml = hecho.url_cobertura
          ? `<a href="${hecho.url_cobertura}" target="_blank" rel="noopener noreferrer"
               style="display:inline-block;margin-top:8px;font-size:11px;color:#1E427C;text-decoration:underline;">
               Ver noticia ↗
             </a>`
          : ''

        infoWindow.setContent(`
          <div style="font-family:system-ui,sans-serif;max-width:260px;padding:2px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px;
                           background:${badgeBg};color:${badgeColor};">${badgeLabel}</span>
              ${hecho.medio ? `<span style="font-size:10px;color:#6B7280;">${hecho.medio}</span>` : ''}
            </div>
            <p style="font-size:13px;font-weight:600;color:#111827;margin:0 0 4px;line-height:1.4;">
              ${hecho.titulo ?? 'Sin título'}
            </p>
            <p style="font-size:11px;color:#6B7280;margin:0;">
              ${hecho.ciudad ?? hecho.provincia ?? '—'}${hecho.provincia && hecho.ciudad ? `, ${hecho.provincia}` : ''} · ${fecha}
            </p>
            ${hecho.tipo_delito ? `<p style="font-size:11px;color:#1E427C;margin:4px 0 0;font-weight:500;">${hecho.tipo_delito}</p>` : ''}
            ${linkHtml}
          </div>
        `)
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
