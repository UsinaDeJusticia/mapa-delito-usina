'use client'

import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'

const USINA_AZUL = '#1E427C'

interface ProvinciaData {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
  totalHechos: number
  totalVictimas: number
  delitos: Array<{ nombre: string; hechos: number; victimas: number }>
}

function getColor(ratio: number): string {
  if (ratio < 0.12) return '#C5D1E4'
  if (ratio < 0.25) return '#9BB1CF'
  if (ratio < 0.40) return '#4A71A5'
  if (ratio < 0.55) return USINA_AZUL
  if (ratio < 0.70) return '#15305B'
  if (ratio < 0.85) return '#0E2240'
  return '#091729'
}

function crearIconoSVG(hechos: number, maxHechos: number): { url: string; size: number } {
  const ratio = maxHechos > 0 ? hechos / maxHechos : 0
  const color = getColor(ratio)

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
}

export function MarcadoresCirculares({ datos, onProvinciaClick }: Props) {
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
      const { url, size } = crearIconoSVG(provincia.totalHechos || 0, maxHechos)

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
        const hechos = (provincia.totalHechos || 0).toLocaleString('es-AR')
        const victimas = (provincia.totalVictimas || 0).toLocaleString('es-AR')

        const topDelitos = (provincia.delitos || [])
          .sort((a, b) => b.hechos - a.hechos)
          .slice(0, 3)
          .map(d => `
            <div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0;">
              <span style="color:#374151;">${d.nombre}</span>
              <span style="font-weight:600;color:${USINA_AZUL};">${d.hechos.toLocaleString('es-AR')}</span>
            </div>
          `)
          .join('')

        infoWindow.setContent(`
          <div style="font-family:system-ui,sans-serif;min-width:200px;padding:4px 2px;">
            <div style="font-weight:700;font-size:14px;color:${USINA_AZUL};margin-bottom:8px;border-bottom:2px solid ${USINA_AZUL};padding-bottom:6px;">
              ${provincia.provincia}
            </div>
            <div style="display:flex;gap:20px;margin-bottom:8px;">
              <div>
                <div style="font-size:11px;color:#6B7280;">Hechos</div>
                <div style="font-size:18px;font-weight:700;color:#111827;">${hechos}</div>
              </div>
              <div>
                <div style="font-size:11px;color:#6B7280;">Víctimas</div>
                <div style="font-size:18px;font-weight:700;color:#111827;">${victimas}</div>
              </div>
            </div>
            ${topDelitos ? `
              <div style="border-top:1px solid #E5E7EB;padding-top:6px;font-size:12px;">
                ${topDelitos}
              </div>
            ` : ''}
            <div style="font-size:10px;color:#9CA3AF;margin-top:6px;">Click para más detalle</div>
          </div>
        `)
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
  }, [map, datos, onProvinciaClick])

  return null
}
