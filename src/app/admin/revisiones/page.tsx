'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { signOut, useSession } from 'next-auth/react'
// useSession requires SessionProvider — provided by src/app/admin/layout.tsx

interface HechoPendiente {
  id: string
  titulo: string | null
  resumen: string | null
  medio: string | null
  provincia: string | null
  ciudad: string | null
  fecha_hecho: string | null
  tipo_delito: string
  confianza: string
  requiere_revision: boolean
  url_fuente: string | null
}

interface HechoRevisado {
  hecho_id: string
  titulo: string | null
  medio: string | null
  provincia: string | null
  confianza_hecho: string
  url_fuente: string | null
  clasificacion_humana: string
  revisado_por: string
  revisado_at: string | null
}

const CLASIFICACIONES = [
  { valor: 'homicidio_doloso',                  etiqueta: 'Homicidio doloso',               emoji: '✅' },
  { valor: 'homicidio_en_ocasion_de_robo',      etiqueta: 'Homicidio en ocasión de robo',   emoji: '🔪' },
  { valor: 'femicidio',                         etiqueta: 'Femicidio',                      emoji: '👩' },
  { valor: 'homicidio_vinculado_al_narcotrafico', etiqueta: 'Vinculado al narcotráfico',    emoji: '💊' },
  { valor: 'no_es_homicidio',                   etiqueta: 'No es homicidio',                emoji: '❌' },
]

const ETIQUETA_CLASIFICACION: Record<string, string> = {
  homicidio_doloso: 'Homicidio doloso',
  homicidio_en_ocasion_de_robo: 'Homicidio en ocasión de robo',
  femicidio: 'Femicidio',
  homicidio_vinculado_al_narcotrafico: 'Vinculado al narcotráfico',
  no_es_homicidio: 'No es homicidio',
}

function nombreCorto(revisadoPor: string) {
  // Muestra solo la parte antes del @ si es email
  return revisadoPor.includes('@') ? revisadoPor.split('@')[0] : revisadoPor
}

function tiempoRelativo(isoString: string | null) {
  if (!isoString) return ''
  const diff = Date.now() - new Date(isoString).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min}m`
  const hs = Math.floor(min / 60)
  if (hs < 24) return `hace ${hs}h`
  return `hace ${Math.floor(hs / 24)}d`
}

function CardRevisado({
  hecho,
  onCorregir,
}: {
  hecho: HechoRevisado
  onCorregir: (hecho: HechoRevisado) => void
}) {
  const esHomicidio = hecho.clasificacion_humana !== 'no_es_homicidio'
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3 sm:p-4 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-800 leading-snug truncate">
          {hecho.titulo ?? 'Sin título'}
        </p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          {hecho.medio ?? '—'}{hecho.provincia ? ` · ${hecho.provincia}` : ''}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
            esHomicidio ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {esHomicidio ? '✓' : '✗'} {ETIQUETA_CLASIFICACION[hecho.clasificacion_humana] ?? hecho.clasificacion_humana}
          </span>
          <span className="text-[10px] text-gray-400">
            {nombreCorto(hecho.revisado_por)} · {tiempoRelativo(hecho.revisado_at)}
          </span>
        </div>
      </div>
      <button
        onClick={() => onCorregir(hecho)}
        className="shrink-0 text-[10px] text-gray-400 hover:text-[#1E427C] border border-gray-200 hover:border-[#1E427C] rounded-lg px-2 py-1 transition-colors"
      >
        Corregir
      </button>
    </div>
  )
}

function CardRevision({
  hecho,
  onRevisado,
  esCorreccion = false,
  onCancelar,
  usuarioActual,
}: {
  hecho: HechoPendiente | HechoRevisado
  onRevisado: (id: string, clasificacion: string, revisadoPor: string) => void
  esCorreccion?: boolean
  onCancelar?: () => void
  usuarioActual: string
}) {
  const [enviando, setEnviando] = useState<string | null>(null)
  const [saliendo, setSaliendo] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const id = 'id' in hecho ? hecho.id : hecho.hecho_id

  async function clasificar(clasificacion: string) {
    setEnviando(clasificacion)
    setErrorMsg(null)
    try {
      const res = await fetch('/api/admin/revisiones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hecho_id: id,
          clasificacion_humana: clasificacion,
          es_correccion: esCorreccion,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (res.status === 401) {
          setErrorMsg('Sesión expirada — volvé a iniciar sesión')
        } else {
          setErrorMsg(data.error ?? `Error ${res.status} — no se guardó`)
        }
        setEnviando(null)
        return
      }

      setSaliendo(true)
      setTimeout(() => onRevisado(id, clasificacion, usuarioActual), 300)
    } catch {
      setErrorMsg('Sin conexión — no se guardó')
      setEnviando(null)
    }
  }

  const titulo = 'titulo' in hecho ? hecho.titulo : null
  const resumen = 'resumen' in hecho ? hecho.resumen : null
  const medio = hecho.medio
  const provincia = hecho.provincia
  const ciudad = 'ciudad' in hecho ? hecho.ciudad : null
  const fechaHecho = 'fecha_hecho' in hecho ? hecho.fecha_hecho : null
  const tipoDelito = 'tipo_delito' in hecho ? hecho.tipo_delito : null
  const confianza = 'confianza' in hecho ? hecho.confianza : null
  const requiereRevision = 'requiere_revision' in hecho ? hecho.requiere_revision : false
  const urlFuente = hecho.url_fuente

  const fechaFormateada = fechaHecho
    ? new Date(fechaHecho).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'Fecha desconocida'

  return (
    <div
      className={`bg-white rounded-xl border p-4 sm:p-5 transition-all duration-300 ${
        esCorreccion ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
      } ${saliendo ? 'opacity-0 scale-95' : 'opacity-100'}`}
    >
      {esCorreccion && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded px-2 py-0.5">
            ✏️ Corrigiendo clasificación
          </span>
          {onCancelar && (
            <button onClick={onCancelar} className="text-[10px] text-gray-400 hover:text-gray-600">
              Cancelar
            </button>
          )}
        </div>
      )}

      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1.5">
          {medio && (
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              {medio}
            </span>
          )}
          {requiereRevision && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
              ⚠️ Revisar
            </span>
          )}
          <span className="ml-auto text-[10px] text-gray-400">{fechaFormateada}</span>
        </div>

        <p className="font-semibold text-gray-900 text-sm leading-snug">
          {titulo ?? 'Sin título'}
        </p>

        <p className="text-xs text-gray-500 mt-0.5">
          {provincia ?? '—'}{ciudad ? ` · ${ciudad}` : ''}
        </p>

        {resumen && (
          <p className="text-xs text-gray-600 mt-2 leading-relaxed line-clamp-3 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
            {resumen}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4">
        {tipoDelito && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
            {tipoDelito}
          </span>
        )}
        {confianza && <span className="text-xs text-gray-400">confianza {confianza}</span>}
        {urlFuente && (
          <a
            href={urlFuente}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-xs underline text-gray-400 hover:text-gray-600 truncate max-w-[140px]"
          >
            Ver noticia ↗
          </a>
        )}
      </div>

      {errorMsg && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
          ⚠️ {errorMsg}
        </p>
      )}

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
  const { data: session } = useSession()
  const usuarioActual = session?.user?.email ?? session?.user?.name ?? 'desconocido'

  const [hechos, setHechos] = useState<HechoPendiente[]>([])
  const [revisados, setRevisados] = useState<HechoRevisado[]>([])
  const [total, setTotal] = useState(0)
  const [cargando, setCargando] = useState(true)
  const [corrigiendoId, setCorrigiendoId] = useState<string | null>(null)
  const ultimoTimestamp = useRef<string>(new Date(Date.now() - 60_000).toISOString())

  const cargar = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/revisiones')
      if (!res.ok) return
      const data = await res.json()
      setHechos(data.pendientes ?? [])
      setTotal(data.total ?? 0)
      setRevisados(data.revisados ?? [])
    } finally {
      setCargando(false)
    }
  }, [])

  // Carga inicial
  useEffect(() => { cargar() }, [cargar])

  // SSE — tiempo real
  useEffect(() => {
    let es: EventSource | null = null
    let pollingFallback: ReturnType<typeof setInterval> | null = null

    function conectar() {
      const url = `/api/admin/revisiones/stream?desde=${encodeURIComponent(ultimoTimestamp.current)}`
      es = new EventSource(url)

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.tipo !== 'revision') return

          ultimoTimestamp.current = msg.revisado_at

          // Quitar de pendientes si está ahí
          setHechos(prev => prev.filter(h => h.id !== msg.hecho_id))
          setTotal(prev => Math.max(0, prev - 1))

          // Agregar/actualizar en revisados
          setRevisados(prev => {
            const sinEste = prev.filter(r => r.hecho_id !== msg.hecho_id)
            return [{
              hecho_id: msg.hecho_id,
              titulo: msg.titulo,
              medio: msg.medio,
              provincia: msg.provincia,
              confianza_hecho: msg.confianza_hecho,
              url_fuente: null,
              clasificacion_humana: msg.clasificacion_humana,
              revisado_por: msg.revisado_por,
              revisado_at: msg.revisado_at,
            }, ...sinEste].slice(0, 50)
          })
        } catch { /* ignorar mensajes mal formados */ }
      }

      es.onerror = () => {
        // EventSource reconecta automáticamente — solo resincronizamos con polling
      }
    }

    conectar()

    // Polling de respaldo cada 30s para el caso de instancias distintas en Vercel
    pollingFallback = setInterval(cargar, 30_000)

    return () => {
      es?.close()
      if (pollingFallback) clearInterval(pollingFallback)
    }
  }, [cargar])

  function handleRevisado(id: string, clasificacion: string, revisadoPor: string) {
    setHechos(prev => prev.filter(h => h.id !== id))
    setTotal(prev => Math.max(0, prev - 1))
    setCorrigiendoId(null)

    const hechoOriginal = hechos.find(h => h.id === id)
    setRevisados(prev => {
      const sinEste = prev.filter(r => r.hecho_id !== id)
      return [{
        hecho_id: id,
        titulo: hechoOriginal?.titulo ?? null,
        medio: hechoOriginal?.medio ?? null,
        provincia: hechoOriginal?.provincia ?? null,
        confianza_hecho: clasificacion !== 'no_es_homicidio' ? 'VERIFICADO' : 'PRELIMINAR',
        url_fuente: hechoOriginal?.url_fuente ?? null,
        clasificacion_humana: clasificacion,
        revisado_por: revisadoPor,
        revisado_at: new Date().toISOString(),
      }, ...sinEste].slice(0, 50)
    })
  }

  function handleCorreccionRevisado(id: string, clasificacion: string, revisadoPor: string) {
    setCorrigiendoId(null)
    setRevisados(prev => prev.map(r =>
      r.hecho_id === id
        ? { ...r, clasificacion_humana: clasificacion, revisado_por: revisadoPor, revisado_at: new Date().toISOString() }
        : r
    ))
    // Si volvió a ser homicidio, ya no reaparece en pendientes (queda en revisados como VERIFICADO)
    // Si se marcó como no_es_homicidio, tampoco reaparece (el polling de 30s lo resuelve si cambia)
  }

  const corrigiendoHecho = revisados.find(r => r.hecho_id === corrigiendoId)

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
      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* Modal de corrección */}
        {corrigiendoId && corrigiendoHecho && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
            <div className="w-full max-w-lg">
              <CardRevision
                hecho={corrigiendoHecho}
                esCorreccion
                onRevisado={handleCorreccionRevisado}
                onCancelar={() => setCorrigiendoId(null)}
                usuarioActual={usuarioActual}
              />
            </div>
          </div>
        )}

        {/* Pendientes */}
        {cargando && (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-3 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!cargando && hechos.length === 0 && revisados.length === 0 && (
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
                usuarioActual={usuarioActual}
              />
            ))}
          </div>
        )}

        {/* Revisados recientes */}
        {!cargando && revisados.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Revisados recientes
              </h2>
              <span className="text-[10px] text-gray-400">(últimas 48hs)</span>
            </div>
            <div className="space-y-2">
              {revisados.map(r => (
                <CardRevisado
                  key={r.hecho_id}
                  hecho={r}
                  onCorregir={(h) => setCorrigiendoId(h.hecho_id)}
                />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
