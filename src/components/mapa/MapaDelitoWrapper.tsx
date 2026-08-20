'use client'

import dynamic from 'next/dynamic'

/**
 * Carga MapaDelito solo en el browser.
 *
 * El `ssr: false` tiene que vivir en un Client Component: desde Next 15 no se
 * permite en un Server Component, y la página `/mapa-del-delito` lo es porque
 * exporta `metadata`. Este archivo ya existía para esto y estaba sin usar —la
 * página hacía su propio dynamic import— así que ahora se usa de verdad.
 *
 * Google Maps necesita `window`, de ahí que no se pueda renderizar en el
 * servidor.
 */
const MapaDelito = dynamic(() => import('@/components/mapa/MapaDelito'), {
  ssr: false,
  // Mismo estado de carga que tenía la página, para que no cambie lo que ve
  // quien entra: alto de pantalla completa y el spinner en el azul de Usina.
  loading: () => (
    <div className="w-full h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-[#2D1B4E] border-t-transparent rounded-full animate-spin" />
        <p className="text-[#2D1B4E] font-medium">Cargando mapa...</p>
      </div>
    </div>
  ),
})

export default MapaDelito
