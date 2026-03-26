'use client'

import { useState, useEffect, useCallback } from 'react'

interface Ubicacion {
  lat: number
  lng: number
  zoom: number
  origen: 'gps' | 'default'
}

// Bounding box de Argentina (incluye Tierra del Fuego)
const ARG_BOUNDS = {
  latMin: -56.0,
  latMax: -21.0,
  lngMin: -74.0,
  lngMax: -53.0,
}

const DEFAULT: Ubicacion = {
  lat: -38.4161,
  lng: -63.6167,
  zoom: 4,
  origen: 'default',
}

function estaEnArgentina(lat: number, lng: number): boolean {
  return (
    lat >= ARG_BOUNDS.latMin &&
    lat <= ARG_BOUNDS.latMax &&
    lng >= ARG_BOUNDS.lngMin &&
    lng <= ARG_BOUNDS.lngMax
  )
}

/**
 * Hook de geolocalización.
 * 
 * v2: timeout extendido a 8s, enableHighAccuracy false para respuesta rápida,
 * maximumAge 10min para usar cache del browser.
 */
export function useGeolocalizacion() {
  const [ubicacion, setUbicacion] = useState<Ubicacion>(DEFAULT)
  const [cargando, setCargando] = useState(true)
  const [disponible, setDisponible] = useState(false)

  useEffect(() => {
    if (!navigator.geolocation) {
      setCargando(false)
      return
    }

    const timeout = setTimeout(() => {
      setCargando(false)
    }, 8000)

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeout)
        const { latitude: lat, longitude: lng } = pos.coords

        if (estaEnArgentina(lat, lng)) {
          setUbicacion({ lat, lng, zoom: 9, origen: 'gps' })
          setDisponible(true)
        }
        setCargando(false)
      },
      () => {
        clearTimeout(timeout)
        setCargando(false)
      },
      {
        enableHighAccuracy: false,
        timeout: 7000,
        maximumAge: 600000, // 10 minutos de cache
      }
    )

    return () => clearTimeout(timeout)
  }, [])

  const recentrar = useCallback(() => {
    return ubicacion.origen === 'gps' ? ubicacion : null
  }, [ubicacion])

  return { ubicacion, cargando, disponible, recentrar }
}