'use client'

import { useState, useEffect, useRef } from 'react'

interface OpcionFiltro {
  valor: string
  total: number
}

interface OpcionesSAT {
  sexo: OpcionFiltro[]
  arma: OpcionFiltro[]
  femicidio: OpcionFiltro[]
  vinculo: OpcionFiltro[]
  lugar: OpcionFiltro[]
}

export interface FiltrosActivos {
  sexo?: string
  arma?: string
  vinculo?: string
  lugar?: string
}

interface FiltrosSATProps {
  filtros: FiltrosActivos
  onChange: (filtros: FiltrosActivos) => void
  visible: boolean
}

// ─── Chip individual ─────────────────────────────────────
function ChipFiltro({
  label,
  valor,
  opciones,
  onChange,
}: {
  label: string
  valor?: string
  opciones: OpcionFiltro[]
  onChange: (valor: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Cerrar al click fuera
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const activo = !!valor

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
          transition-all whitespace-nowrap
          ${activo
            ? 'bg-[#1E427C] text-white shadow-sm'
            : 'bg-white/80 text-gray-600 hover:bg-white hover:text-[#1E427C] border border-gray-200'
          }
        `}
      >
        {activo ? valor : label}
        <svg
          width="10" height="10" viewBox="0 0 10 10"
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {activo && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              onChange(undefined)
              setOpen(false)
            }}
            className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full hover:bg-white/20 cursor-pointer"
          >
            ×
          </span>
        )}
      </button>

      {open && opciones.length > 0 && (
        <div className="absolute top-full left-0 mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-50 min-w-[180px] max-h-64 overflow-y-auto">
          {/* Opción "Todos" */}
          <button
            onClick={() => { onChange(undefined); setOpen(false) }}
            className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors ${
              !valor ? 'text-[#1E427C] font-semibold bg-[#1E427C]/5' : 'text-gray-600'
            }`}
          >
            Todos
          </button>

          {opciones.map((op) => (
            <button
              key={op.valor}
              onClick={() => { onChange(op.valor); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex justify-between items-center ${
                valor === op.valor ? 'text-[#1E427C] font-semibold bg-[#1E427C]/5' : 'text-gray-600'
              }`}
            >
              <span className="truncate mr-2">{op.valor}</span>
              <span className="text-gray-300 text-[10px] shrink-0">
                {op.total.toLocaleString('es-AR')}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Barra de filtros SAT ────────────────────────────────
export function FiltrosSAT({ filtros, onChange, visible }: FiltrosSATProps) {
  const [opciones, setOpciones] = useState<OpcionesSAT | null>(null)
  const [loading, setLoading] = useState(false)

  // Cargar opciones al montar (una sola vez)
  useEffect(() => {
    if (!visible || opciones) return

    async function fetchOpciones() {
      setLoading(true)
      try {
        const res = await fetch('/api/mapa/sat-opciones')
        if (res.ok) {
          const data = await res.json()
          setOpciones(data)
        }
      } catch (err) {
        console.error('Error cargando opciones SAT:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchOpciones()
  }, [visible, opciones])

  if (!visible) return null

  const hayFiltrosActivos = Object.values(filtros).some(v => v !== undefined)

  const handleChange = (campo: keyof FiltrosActivos, valor: string | undefined) => {
    onChange({ ...filtros, [campo]: valor })
  }

  const limpiarTodo = () => {
    onChange({})
  }

  if (loading || !opciones) {
    return (
      <div className="w-full">
        <div className="bg-white/90 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2 flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-gray-400">Cargando filtros...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full transition-all duration-300">
      <div className="bg-white/90 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mr-1">
          Filtros
        </span>

        <ChipFiltro
          label="Sexo"
          valor={filtros.sexo}
          opciones={opciones.sexo}
          onChange={(v) => handleChange('sexo', v)}
        />

        <ChipFiltro
          label="Arma"
          valor={filtros.arma}
          opciones={opciones.arma}
          onChange={(v) => handleChange('arma', v)}
        />

        <ChipFiltro
          label="Vínculo"
          valor={filtros.vinculo}
          opciones={opciones.vinculo}
          onChange={(v) => handleChange('vinculo', v)}
        />

        <ChipFiltro
          label="Lugar"
          valor={filtros.lugar}
          opciones={opciones.lugar}
          onChange={(v) => handleChange('lugar', v)}
        />

        {hayFiltrosActivos && (
          <button
            onClick={limpiarTodo}
            className="text-[10px] text-red-400 hover:text-red-600 font-medium ml-1 transition-colors"
          >
            Limpiar
          </button>
        )}
      </div>
    </div>
  )
}
// Placeholder para FiltrosSAT