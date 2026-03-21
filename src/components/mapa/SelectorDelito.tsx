'use client'

import { useState, useEffect } from 'react'

interface TipoDelito {
  id: string
  codigoSnic: number
  nombre: string
  categoria: string
}

export function SelectorDelito({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (id: string | undefined) => void
}) {
  const [tipos, setTipos] = useState<TipoDelito[]>([])

  useEffect(() => {
    fetch('/api/mapa/tipos-delito')
      .then(res => res.json())
      .then(data => setTipos(data.tipos || []))
      .catch(console.error)
  }, [])

  return (
    <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-3">
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="text-sm text-usina-900 bg-transparent border-none outline-none cursor-pointer font-medium"
        aria-label="Filtrar por tipo de delito"
      >
        <option value="">Todos los delitos</option>
        {tipos.map(t => (
          <option key={t.id} value={t.id}>
            {t.nombre}
          </option>
        ))}
      </select>
    </div>
  )
}