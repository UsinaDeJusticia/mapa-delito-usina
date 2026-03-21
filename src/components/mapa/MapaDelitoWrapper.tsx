'use client'

import dynamic from 'next/dynamic'

const MapaDelito = dynamic(
  () => import('@/components/mapa/MapaDelito'),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-gray-100">
        <p className="text-gray-500">Cargando mapa...</p>
      </div>
    ),
  }
)

export default MapaDelito
