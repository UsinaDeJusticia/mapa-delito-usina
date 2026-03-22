'use client'

import { useState, useEffect, useCallback } from 'react'

interface Ubicacion {
  lat: number
  lng: number
  zoom: number
  origen: 'gps' | 'default'
}

const ARG_BOUNDS = {
  latMin: -55.2,
  latMax: -21.7,
  lngMin: -73.6,
  lngMax: -53.6,
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
    }, 5000)

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeout)
        const { latitude: lat, longitude: lng } = pos.coords

        if (estaEnArgentina(lat, lng)) {
          setUbicacion({ lat, lng, zoom: 10, origen: 'gps' })
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
        timeout: 4500,
        maximumAge: 300000,
      }
    )

    return () => clearTimeout(timeout)
  }, [])

  const recentrar = useCallback(() => {
    return ubicacion.origen === 'gps' ? ubicacion : null
  }, [ubicacion])

  return { ubicacion, cargando, disponible, recentrar }
}
