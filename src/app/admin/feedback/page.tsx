'use client'

import { useEffect, useState, useCallback } from 'react'
import AdminNav from '@/components/admin/AdminNav'

interface FeedbackItem {
  id: number
  categoria: string
  mensaje: string
  autor: string
  created_at: string
}

const CATEGORIAS = [
  { valor: 'sugerencia', etiqueta: 'Sugerencia', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { valor: 'error', etiqueta: 'Error', color: 'bg-red-50 text-red-700 border-red-200' },
  { valor: 'mejora', etiqueta: 'Mejora', color: 'bg-green-50 text-green-700 border-green-200' },
]

function nombreCorto(email: string) {
  return email.includes('@') ? email.split('@')[0] : email
}

function tiempoRelativo(isoString: string) {
  const diff = Date.now() - new Date(isoString).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min}m`
  const hs = Math.floor(min / 60)
  if (hs < 24) return `hace ${hs}h`
  return `hace ${Math.floor(hs / 24)}d`
}

export default function FeedbackPage() {
  const [items, setItems] = useState<FeedbackItem[]>([])
  const [cargando, setCargando] = useState(true)
  const [categoria, setCategoria] = useState('sugerencia')
  const [mensaje, setMensaje] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [exito, setExito] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/feedback')
      if (!res.ok) return
      const data = await res.json()
      setItems(data.items ?? [])
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => { cargar() }, [cargar])

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    if (!mensaje.trim()) return

    setEnviando(true)
    setErrorMsg(null)
    setExito(false)

    try {
      const res = await fetch('/api/admin/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoria, mensaje: mensaje.trim() }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setErrorMsg(data.error ?? 'Error al enviar')
        return
      }

      setMensaje('')
      setExito(true)
      setTimeout(() => setExito(false), 3000)
      cargar()
    } catch {
      setErrorMsg('Sin conexión — no se envió')
    } finally {
      setEnviando(false)
    }
  }

  const categoriaInfo = (valor: string) =>
    CATEGORIAS.find(c => c.valor === valor) ?? CATEGORIAS[0]

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h2 className="font-bold text-gray-900 text-sm" style={{ color: '#1E427C' }}>
            Buzón de feedback
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Sugerencias, errores o mejoras para el sistema
          </p>
        </div>

        {/* Formulario */}
        <form onSubmit={enviar} className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 space-y-4">
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">Categoría</p>
            <div className="flex gap-2">
              {CATEGORIAS.map(c => (
                <button
                  key={c.valor}
                  type="button"
                  onClick={() => setCategoria(c.valor)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                    categoria === c.valor
                      ? c.color + ' border'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {c.etiqueta}
                </button>
              ))}
            </div>
          </div>

          <div>
            <textarea
              value={mensaje}
              onChange={e => setMensaje(e.target.value)}
              placeholder="Describí tu sugerencia, error o mejora..."
              rows={3}
              className="w-full text-sm text-gray-800 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-[#1E427C] focus:ring-1 focus:ring-[#1E427C] resize-none placeholder:text-gray-400"
            />
          </div>

          {errorMsg && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {errorMsg}
            </p>
          )}

          {exito && (
            <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              Feedback enviado correctamente
            </p>
          )}

          <button
            type="submit"
            disabled={enviando || !mensaje.trim()}
            className="w-full sm:w-auto px-6 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#1E427C' }}
          >
            {enviando ? 'Enviando...' : 'Enviar feedback'}
          </button>
        </form>

        {/* Lista */}
        {cargando && (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-3 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!cargando && items.length === 0 && (
          <div className="text-center py-12">
            <p className="text-sm text-gray-400">No hay feedback todavía. Se el primero en enviar.</p>
          </div>
        )}

        {!cargando && items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Todos los feedbacks ({items.length})
            </p>
            {items.map(item => {
              const cat = categoriaInfo(item.categoria)
              return (
                <div key={item.id} className="bg-white rounded-xl border border-gray-100 p-3 sm:p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cat.color}`}>
                      {cat.etiqueta}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {nombreCorto(item.autor)} · {tiempoRelativo(item.created_at)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                    {item.mensaje}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
