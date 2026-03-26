'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

interface Provincia {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
}

interface Props {
  provincias: Provincia[]
  onSeleccionar: (provincia: Provincia) => void
}

/**
 * Buscador de provincia con autocomplete.
 * El usuario escribe y se filtran las provincias.
 * Al seleccionar, dispara onSeleccionar para que el mapa vuele ahí.
 */
export function BuscadorProvincia({ provincias, onSeleccionar }: Props) {
  const [texto, setTexto] = useState('')
  const [abierto, setAbierto] = useState(false)
  const [indiceActivo, setIndiceActivo] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listaRef = useRef<HTMLDivElement>(null)

  // Normalizar para búsqueda (sin acentos, minúsculas)
  const normalizar = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

  // Filtrar provincias por texto
  const filtradas = texto.trim().length > 0
    ? provincias.filter(p => normalizar(p.provincia).includes(normalizar(texto)))
    : provincias

  const seleccionar = useCallback((provincia: Provincia) => {
    setTexto('')
    setAbierto(false)
    setIndiceActivo(-1)
    onSeleccionar(provincia)
  }, [onSeleccionar])

  // Teclado: flechas + enter + escape
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!abierto) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setAbierto(true)
        return
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndiceActivo(prev => Math.min(prev + 1, filtradas.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndiceActivo(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && indiceActivo >= 0) {
      e.preventDefault()
      seleccionar(filtradas[indiceActivo])
    } else if (e.key === 'Escape') {
      setAbierto(false)
      setTexto('')
      inputRef.current?.blur()
    }
  }

  // Cerrar al clickear fuera
  useEffect(() => {
    const handleClickFuera = (e: MouseEvent) => {
      if (listaRef.current && !listaRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setAbierto(false)
      }
    }
    document.addEventListener('mousedown', handleClickFuera)
    return () => document.removeEventListener('mousedown', handleClickFuera)
  }, [])

  return (
    <div className="relative">
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg flex items-center">
        {/* Ícono lupa */}
        <div className="pl-3 pr-1 text-gray-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value)
            setAbierto(true)
            setIndiceActivo(-1)
          }}
          onFocus={() => setAbierto(true)}
          onKeyDown={handleKeyDown}
          placeholder="Buscar provincia..."
          className="w-32 sm:w-44 px-2 py-2.5 text-sm bg-transparent border-none outline-none text-[#1E427C] placeholder:text-gray-400 font-medium"
          aria-label="Buscar provincia"
          aria-expanded={abierto}
          aria-controls="lista-provincias"
          role="combobox"
          autoComplete="off"
        />
        {/* Botón limpiar */}
        {texto && (
          <button
            onClick={() => { setTexto(''); setAbierto(false); inputRef.current?.focus() }}
            className="pr-3 text-gray-400 hover:text-gray-600"
            aria-label="Limpiar búsqueda"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Dropdown de resultados */}
      {abierto && filtradas.length > 0 && (
        <div
          ref={listaRef}
          id="lista-provincias"
          role="listbox"
          className="absolute top-full left-0 mt-1 w-64 max-h-64 overflow-y-auto bg-white/98 backdrop-blur-sm rounded-xl shadow-xl border border-gray-100 z-50"
        >
          {filtradas.map((p, i) => (
            <button
              key={p.provinciaId}
              role="option"
              aria-selected={i === indiceActivo}
              onClick={() => seleccionar(p)}
              onMouseEnter={() => setIndiceActivo(i)}
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                i === indiceActivo
                  ? 'bg-[#1E427C]/10 text-[#1E427C] font-semibold'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {p.provincia}
            </button>
          ))}
        </div>
      )}

      {/* Sin resultados */}
      {abierto && texto.trim().length > 0 && filtradas.length === 0 && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white/98 backdrop-blur-sm rounded-xl shadow-xl border border-gray-100 z-50 px-4 py-3 text-sm text-gray-400">
          No se encontraron provincias
        </div>
      )}
    </div>
  )
}
