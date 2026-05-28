'use client'

import { useEffect, useState, useCallback } from 'react'
import { signOut } from 'next-auth/react'

interface HechoPendiente {
  id: string
  titulo: string | null
  provincia: string | null
  ciudad: string | null
  fecha_hecho: string | null
  tipo_delito: string
  confianza: string
  url_fuente: string | null
}

const CLASIFICACIONES = [
  { valor: 'homicidio_doloso',                  etiqueta: 'Homicidio doloso',               emoji: '✅' },
  { valor: 'homicidio_en_ocasion_de_robo',      etiqueta: 'Homicidio en ocasión de robo',   emoji: '🔪' },
  { valor: 'femicidio',                         etiqueta: 'Femicidio',                      emoji: '👩' },
  { valor: 'homicidio_vinculado_al_narcotrafico', etiqueta: 'Vinculado al narcotráfico',    emoji: '💊' },
  { valor: 'no_es_homicidio',                   etiqueta: 'No es homicidio',                emoji: '❌' },
]

function CardRevision({
  hecho,
  onRevisado,
}: {
  hecho: HechoPendiente
  onRevisado: (id: string) => void
}) {
  const [enviando, setEnviando] = useState<string | null>(null)
  const [saliendo, setSaliendo] = useState(false)

  async function clasificar(clasificacion: string) {
    setEnviando(clasificacion)
    try {
      await fetch('/api/admin/revisiones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hecho_id: hecho.id, clasificacion_humana: clasificacion }),
      })
      setSaliendo(true)
      setTimeout(() => onRevisado(hecho.id), 300)
    } catch {
      setEnviando(null)
    }
  }

  const fechaFormateada = hecho.fecha_hecho
    ? new Date(hecho.fecha_hecho).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'Fecha desconocida'

  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 p-4 sm:p-5 transition-all duration-300 ${
        saliendo ? 'opacity-0 scale-95' : 'opacity-100'
      }`}
    >
      <div className="mb-3">
        <p className="font-medium text-gray-900 text-sm leading-snug line-clamp-2">
          {hecho.titulo ?? 'Sin título'}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-gray-500">
          <span>{hecho.provincia ?? '—'}{hecho.ciudad ? ` · ${hecho.ciudad}` : ''}</span>
          <span>{fechaFormateada}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
          {hecho.tipo_delito}
        </span>
        <span className="text-xs text-gray-400">confianza {hecho.confianza}</span>
        {hecho.url_fuente && (
          <a
            href={hecho.url_fuente}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs underline text-gray-400 hover:text-gray-600 truncate max-w-[120px]"
          >
            Ver noticia ↗
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {CLASIFICACIONES.map(c => (
          <button
            key={c.valor}
            onClick={() => clasificar(c.valor)}
            disabled={enviando !== null}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors
              ${enviando === c.valor
                ? 'border-[#1E427C] bg-[#1E427C] text-white'
                : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-[#1E427C] hover:bg-blue-50 hover:text-[#1E427C]'
              }
              disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            <span>{c.emoji}</span>
            <span className="leading-tight">{c.etiqueta}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function RevisionesPage() {
  const [hechos, setHechos] = useState<HechoPendiente[]>([])
  const [total, setTotal] = useState(0)
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      const res = await fetch('/api/admin/revisiones')
      const data = await res.json()
      setHechos(data.pendientes ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  function handleRevisado(id: string) {
    setHechos(prev => prev.filter(h => h.id !== id))
    setTotal(prev => Math.max(0, prev - 1))
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900 text-sm sm:text-base" style={{ color: '#1E427C' }}>
              Revisión de casos
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {cargando ? 'Cargando...' : `${total} pendiente${total !== 1 ? 's' : ''}`}
            </p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/admin/login' })}
            className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
          >
            Cerrar sesión
          </button>
        </div>
      </header>

      {/* Contenido */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {cargando && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-3 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!cargando && hechos.length === 0 && (
          <div className="text-center py-20">
            <p className="text-4xl mb-3">🎉</p>
            <p className="font-semibold text-gray-700">No hay casos pendientes de revisión</p>
            <p className="text-sm text-gray-400 mt-1">Volvé más tarde cuando el pipeline procese nuevas noticias.</p>
          </div>
        )}

        {!cargando && hechos.length > 0 && (
          <div className="space-y-3">
            {hechos.map(hecho => (
              <CardRevision
                key={hecho.id}
                hecho={hecho}
                onRevisado={handleRevisado}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
