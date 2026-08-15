import type { Metadata } from 'next'
// El dynamic import con ssr:false vive en el wrapper, que es Client Component.
// Desde Next 15 no se puede declarar acá: esta página es Server Component
// porque exporta `metadata`.
import MapaDelito from '@/components/mapa/MapaDelitoWrapper'

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
