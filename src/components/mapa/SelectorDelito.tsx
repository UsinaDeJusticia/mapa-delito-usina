'use client'

import { useState, useEffect, useRef } from 'react'

interface TipoDelito {
  id: string
  codigoSnic: number
  nombre: string
  categoria: string
}

// Nombres legibles para categorías
const CATEGORIAS: Record<string, string> = {
  CONTRA_PERSONAS: 'Contra las personas',
  CONTRA_PROPIEDAD: 'Contra la propiedad',
  CONTRA_LIBERTAD: 'Contra la libertad',
  CONTRA_INTEGRIDAD_SEXUAL: 'Integridad sexual',
  ESTUPEFACIENTES: 'Estupefacientes',
  OTROS: 'Otros',
}

export function SelectorDelito({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (id: string | undefined) => void
}) {
  const [tipos, setTipos] = useState<TipoDelito[]>([])
  const [abierto, setAbierto] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/mapa/tipos-delito')
      .then(res => res.json())
      .then(data => setTipos(data.tipos || []))
      .catch(console.error)
  }, [])

  // Cerrar al clickear fuera
  useEffect(() => {
    const handleClickFuera = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAbierto(false)
      }
    }
    document.addEventListener('mousedown', handleClickFuera)
    return () => document.removeEventListener('mousedown', handleClickFuera)
  }, [])

  // Agrupar por categoría
  const porCategoria = tipos.reduce<Record<string, TipoDelito[]>>((acc, t) => {
    const cat = t.categoria || 'OTROS'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(t)
    return acc
  }, {})

  const seleccionado = tipos.find(t => t.id === value)
  const label = seleccionado?.nombre || 'Todos los delitos'

  return (
    <div ref={containerRef} className="relative">
      {/* Botón trigger */}
      <button
        onClick={() => setAbierto(!abierto)}
        className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2 text-sm font-medium text-[#1E427C] hover:bg-white transition-colors min-w-[160px] sm:min-w-[200px]"
        aria-expanded={abierto}
        aria-haspopup="listbox"
        aria-label="Filtrar por tipo de delito"
      >
        <span className="truncate flex-1 text-left">{label}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform ${abierto ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown */}
      {abierto && (
        <div
          role="listbox"
          className="absolute top-full left-0 mt-1 w-72 max-h-80 overflow-y-auto bg-white/98 backdrop-blur-sm rounded-xl shadow-xl border border-gray-100 z-50 py-1"
        >
          {/* Opción "Todos" */}
          <button
            role="option"
            aria-selected={!value}
            onClick={() => { onChange(undefined); setAbierto(false) }}
            className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
              !value
                ? 'bg-[#1E427C]/10 text-[#1E427C] font-semibold'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            Todos los delitos
          </button>

          {/* Agrupados por categoría */}
          {Object.entries(porCategoria).map(([cat, delitos]) => (
            <div key={cat}>
              <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {CATEGORIAS[cat] || cat}
              </div>
              {delitos.map(t => (
                <button
                  key={t.id}
                  role="option"
                  aria-selected={value === t.id}
                  onClick={() => { onChange(t.id); setAbierto(false) }}
                  className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                    value === t.id
                      ? 'bg-[#1E427C]/10 text-[#1E427C] font-semibold'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {t.nombre}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
