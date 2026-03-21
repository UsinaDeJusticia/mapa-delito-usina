import dynamic from 'next/dynamic'
import type { Metadata } from 'next'

// Dynamic import porque Google Maps requiere window
const MapaDelito = dynamic(
  () => import('@/components/mapa/MapaDelito'),
  { ssr: false, loading: () => (
    <div className="w-full h-screen flex items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-[#2D1B4E] border-t-transparent rounded-full animate-spin" />
        <p className="text-[#2D1B4E] font-medium">Cargando mapa...</p>
      </div>
    </div>
  )}
)

export const metadata: Metadata = {
  title: 'Mapa Nacional del Delito | Usina de Justicia',
  description: 'Mapa interactivo de criminalidad en Argentina. Datos oficiales del SNIC con cobertura nacional y profundidad temporal desde 2014. Una herramienta pública de Usina de Justicia.',
  openGraph: {
    title: 'Mapa Nacional del Delito | Usina de Justicia',
    description: 'Visualizá los datos de criminalidad de Argentina provincia por provincia.',
    type: 'website',
  },
}

export default function MapaDelDelitoPage() {
  return <MapaDelito />
}