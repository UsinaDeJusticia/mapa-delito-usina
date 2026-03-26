'use client'

import { useState, useEffect } from 'react'

interface Props {
  provinciaId?: string | null
  onChange: (departamentoId: string | null) => void
  value?: string | null
}

interface Departamento {
  departamento: string
  departamentoId: string
}

export function FiltroDepartamento({ provinciaId, onChange, value }: Props) {
  const [departamentos, setDepartamentos] = useState<Departamento[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (!provinciaId) {
      setDepartamentos([])
      return
    }

    const fetchDepartamentos = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/mapa/departamentos?provinciaId=${provinciaId}`)
        if (res.ok) {
          const data = await res.json()
          setDepartamentos(data.departamentos || [])
        }
      } catch {
        setDepartamentos([])
      } finally {
        setLoading(false)
      }
    }

    fetchDepartamentos()
  }, [provinciaId])

  const filtrados = search.trim()
    ? departamentos.filter(d =>
        d.departamento.toLowerCase().includes(search.toLowerCase())
      )
    : departamentos

  const selectedDepto = departamentos.find(d => d.departamentoId === value)

  if (!provinciaId) {
    return (
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2 opacity-50 cursor-not-allowed">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-gray-400 shrink-0"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M3 12h18M12 3v18" />
        </svg>
        <span className="text-sm text-gray-400 font-medium">
          Departamento
        </span>
        <span className="text-[9px] text-gray-300 bg-gray-100 rounded px-1.5 py-0.5 font-medium">
          Seleccionar provincia
        </span>
      </div>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2 hover:bg-white transition-colors"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[#1E427C] shrink-0"
        >
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M3 12h18M12 3v18" />
        </svg>
        <span className="text-sm font-medium text-[#1E427C]">
          {selectedDepto?.departamento || 'Departamento'}
        </span>
        {loading && (
          <div className="w-3.5 h-3.5 border-2 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white/98 backdrop-blur-sm rounded-xl shadow-xl border border-gray-100 z-50 overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar departamento..."
              className="w-full px-3 py-2 text-sm bg-gray-50 rounded-lg border-none outline-none focus:ring-1 focus:ring-[#1E427C]/30"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              onClick={() => {
                onChange(null)
                setOpen(false)
                setSearch('')
              }}
              className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors ${
                !value ? 'text-[#1E427C] font-semibold bg-[#1E427C]/5' : 'text-gray-700'
              }`}
            >
              Todos los departamentos
            </button>
            {filtrados.map((d) => (
              <button
                key={d.departamentoId}
                onClick={() => {
                  onChange(d.departamentoId)
                  setOpen(false)
                  setSearch('')
                }}
                className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 transition-colors ${
                  value === d.departamentoId ? 'text-[#1E427C] font-semibold bg-[#1E427C]/5' : 'text-gray-700'
                }`}
              >
                {d.departamento}
              </button>
            ))}
            {!loading && filtrados.length === 0 && (
              <div className="px-4 py-3 text-sm text-gray-400 text-center">
                Sin resultados
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  )
}
