'use client'

import { useState, useEffect } from 'react'
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

interface TipoDelito {
  id: string
  nombre: string
  codigoSnic: number
}

export default function Dashboard() {
  const [tiposDelito, setTiposDelito] = useState<TipoDelito[]>([])
  const [anio, setAnio] = useState(2024)
  const [tipoDelitoId, setTipoDelitoId] = useState<string>('')

  useEffect(() => {
    fetch('/api/mapa/tipos-delito')
      .then(res => res.json())
      .then(data => {
        setTiposDelito(data.tipos || [])
        if (data.tipos?.length > 0) {
          setTipoDelitoId(data.tipos[0].id)
        }
      })
      .catch(err => console.error('Error fetching tipos:', err))
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-[#2D1B4E] text-white p-4">
        <h1 className="text-xl font-bold">Mapa Nacional del Delito</h1>
      </header>

      <main className="p-4">
        <div className="flex flex-wrap gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Año</label>
            <select
              value={anio}
              onChange={(e) => setAnio(Number(e.target.value))}
              className="border border-gray-300 rounded px-3 py-2"
            >
              <option value={2024}>2024</option>
              <option value={2023}>2023</option>
              <option value={2022}>2022</option>
              <option value={2021}>2021</option>
              <option value={2020}>2020</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Delito</label>
            <select
              value={tipoDelitoId}
              onChange={(e) => setTipoDelitoId(e.target.value)}
              className="border border-gray-300 rounded px-3 py-2 min-w-[250px]"
            >
              {tiposDelito.map((tipo) => (
                <option key={tipo.id} value={tipo.id}>
                  {tipo.codigoSnic} - {tipo.nombre}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="h-[600px] bg-white rounded-lg shadow-md overflow-hidden">
          {tipoDelitoId && (
            <MapaDelito anio={anio} tipoDelitoId={tipoDelitoId} />
          )}
        </div>
      </main>
    </div>
  )
}
