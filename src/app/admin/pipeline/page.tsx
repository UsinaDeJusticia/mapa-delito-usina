'use client'

/**
 * Panel de control del pipeline de medios.
 *
 * Desde acá se encolan corridas que ejecuta el agente local en la computadora
 * del equipo (scripts/pipeline/agente-local.ts), se sigue su progreso y su log
 * en vivo, se cancelan, y se ve el historial — incluidas las corridas
 * programadas y las de GitHub Actions. Ver docs/agente-local.md.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AdminNav from '@/components/admin/AdminNav'

// ════════════════════════════════════════════
// TIPOS (espejo de /api/admin/pipeline)
// ════════════════════════════════════════════

interface Parametros {
  medios?: string[]
  provincias?: string[]
  incluirNacionales?: boolean
  incluirNoVerificados?: boolean
  foco?: string[]
  maxNoticias?: number
  dryRun?: boolean
}

interface Contadores {
  noticiasScrapeadas: number
  hechosExtraidos: number
  hechosNuevos: number
  coberturasVinculadas: number
  duplicados: number
  descartados: number
}

interface Progreso {
  totalMedios: number
  medioIndice: number
  medio: string | null
  fase: string
  contadores: Contadores
}

interface Resumen extends Contadores {
  estado: 'ok' | 'fallida'
  motivoFallo?: string
  perfilLLM?: string
  medios?: Array<{ medio: string; identificadas: number; extraidas: number; problema?: string }>
  tiemposMs?: Record<string, number>
}

interface Corrida {
  id: string
  estado: 'pendiente' | 'en_curso' | 'completada' | 'fallida' | 'cancelada'
  origen: 'panel' | 'programada' | 'github-actions' | 'cli'
  solicitadaPor: string | null
  parametros: Parametros
  agente: string | null
  progreso: Progreso | null
  resumen: Resumen | null
  error: string | null
  exitCode: number | null
  cancelacionSolicitada: boolean
  creadaAt: string
  iniciadaAt: string | null
  finalizadaAt: string | null
  latidoAt: string | null
  sinLatido: boolean
}

interface Agente {
  nombre: string
  latidoAt: string
  conectado: boolean
  info: {
    plataforma?: string
    horaProgramada?: string | null
    perfilLLM?: string
    razonamiento?: string
    corridaEnCurso?: string | null
  }
}

interface ProvinciaCatalogo {
  provincia: string
  activos: number
  noVerificados: number
  medios: Array<{ id: string; nombre: string; activo: boolean }>
}

interface Estado {
  ahora: string
  agentes: Agente[]
  corridas: Corrida[]
  catalogo: {
    provincias: ProvinciaCatalogo[]
    nacionales: Array<{ id: string; nombre: string }>
    totalActivos: number
  }
  limites: { maxNoticias: { min: number; max: number; porDefecto: number }; foco: { items: number; largo: number } }
}

interface Linea {
  id: number
  ts: string
  texto: string
}

// ════════════════════════════════════════════
// FORMATO
// ════════════════════════════════════════════

const ZONA = 'America/Argentina/Buenos_Aires'
const FMT_FECHA_HORA = new Intl.DateTimeFormat('es-AR', {
  timeZone: ZONA, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const FMT_FECHA = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' })

function fechaHora(iso: string | null): string {
  return iso ? FMT_FECHA_HORA.format(new Date(iso)) : '—'
}

function haceCuanto(iso: string | null, ahora: number): string {
  if (!iso) return 'nunca'
  const s = Math.max(0, Math.round((ahora - new Date(iso).getTime()) / 1000))
  if (s < 60) return `hace ${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} días`
}

function duracion(desde: string | null, hasta: string | null, ahora: number): string {
  if (!desde) return '—'
  const ms = (hasta ? new Date(hasta).getTime() : ahora) - new Date(desde).getTime()
  const min = Math.floor(ms / 60000)
  const seg = Math.floor((ms % 60000) / 1000)
  if (min >= 60) return `${Math.floor(min / 60)} h ${min % 60} min`
  return min > 0 ? `${min} min ${seg} s` : `${seg} s`
}

function alcance(p: Parametros): string {
  if (p.medios && p.medios.length > 0) return `Medios: ${p.medios.join(', ')}`
  if (p.provincias && p.provincias.length > 0) {
    const extras = [p.incluirNacionales ? '+ nacionales' : '', p.incluirNoVerificados ? '+ no verificados' : '']
      .filter(Boolean).join(' ')
    return `${p.provincias.join(', ')}${extras ? ` ${extras}` : ''}`
  }
  return 'Todos los medios activos'
}

const ORIGENES: Record<Corrida['origen'], string> = {
  panel: 'Panel',
  programada: 'Programada',
  'github-actions': 'GitHub Actions',
  cli: 'Consola',
}

const ESTADOS: Record<Corrida['estado'], { texto: string; clase: string }> = {
  pendiente: { texto: 'En cola', clase: 'bg-gray-100 text-gray-600 border-gray-200' },
  en_curso: { texto: 'En curso', clase: 'bg-blue-50 text-[#1E427C] border-blue-200' },
  completada: { texto: 'Completada', clase: 'bg-green-50 text-green-700 border-green-200' },
  fallida: { texto: 'Fallida', clase: 'bg-red-50 text-red-700 border-red-200' },
  cancelada: { texto: 'Cancelada', clase: 'bg-amber-50 text-amber-700 border-amber-200' },
}

const FASES: Record<string, string> = {
  preparando: 'Preparando',
  'verificando-llm': 'Verificando el proveedor de IA',
  navegando: 'Abriendo notas',
  identificando: 'Identificando noticias con IA',
  extrayendo: 'Extrayendo datos',
  finalizando: 'Terminando',
}

const DOCS_AGENTE = 'https://github.com/UsinaDeJusticia/mapa-delito-usina/blob/master/docs/agente-local.md'

// ════════════════════════════════════════════
// PIEZAS
// ════════════════════════════════════════════

function Insignia({ estado }: { estado: Corrida['estado'] }) {
  const e = ESTADOS[estado]
  return (
    <span className={`inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border ${e.clase}`}>
      {e.texto}
    </span>
  )
}

function Tarjeta({ titulo, children, accion }: { titulo: string; children: React.ReactNode; accion?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-700">{titulo}</h2>
        {accion}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function Contador({ etiqueta, valor, color = 'text-gray-800' }: { etiqueta: string; valor: number; color?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <p className="text-[11px] text-gray-500">{etiqueta}</p>
      <p className={`text-lg font-bold ${color}`}>{valor.toLocaleString('es-AR')}</p>
    </div>
  )
}

function Contadores({ c }: { c: Contadores }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      <Contador etiqueta="Notas leídas" valor={c.noticiasScrapeadas} />
      <Contador etiqueta="Hechos" valor={c.hechosExtraidos} />
      <Contador etiqueta="Nuevos" valor={c.hechosNuevos} color="text-[#1E427C]" />
      <Contador etiqueta="Coberturas" valor={c.coberturasVinculadas} />
      <Contador etiqueta="Ya estaban" valor={c.duplicados} color="text-gray-500" />
      <Contador etiqueta="Descartadas" valor={c.descartados} color="text-gray-500" />
    </div>
  )
}

// ════════════════════════════════════════════
// AGENTE
// ════════════════════════════════════════════

function EstadoAgente({ agentes, corridas, ahora }: { agentes: Agente[]; corridas: Corrida[]; ahora: number }) {
  const conectado = agentes.find(a => a.conectado)
  const ultimo = agentes[0]

  if (conectado) {
    const hora = conectado.info.horaProgramada
    const hoy = FMT_FECHA.format(new Date(ahora))
    const programadaHoy = corridas.some(c => c.origen === 'programada' && FMT_FECHA.format(new Date(c.creadaAt)) === hoy)
    return (
      <div className="flex items-start gap-3">
        <span className="mt-1.5 w-2.5 h-2.5 rounded-full bg-green-600 shrink-0" aria-hidden />
        <div className="text-sm text-gray-700 space-y-0.5">
          <p>
            <strong>Agente conectado:</strong> {conectado.nombre}{' '}
            <span className="text-gray-400 text-xs">· último contacto {haceCuanto(conectado.latidoAt, ahora)}</span>
          </p>
          <p className="text-xs text-gray-500">
            {hora
              ? <>Corrida diaria a las {hora} (hora argentina) · {programadaHoy ? 'la de hoy ya se hizo' : 'la de hoy todavía no'}</>
              : 'Sin corrida diaria programada'}
          </p>
          {conectado.info.perfilLLM && (
            <p className="text-xs text-gray-400">Modelo: {conectado.info.perfilLLM} · razonamiento: {conectado.info.razonamiento}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3">
      <span className="mt-1.5 w-2.5 h-2.5 rounded-full bg-gray-300 shrink-0" aria-hidden />
      <div className="text-sm text-gray-700 space-y-1.5">
        <p>
          <strong>No hay ningún agente conectado.</strong>{' '}
          {ultimo && <span className="text-gray-500">({ultimo.nombre} se desconectó {haceCuanto(ultimo.latidoAt, ahora)})</span>}
        </p>
        <p className="text-xs text-gray-500">
          Las corridas que encoles esperan hasta que el agente se inicie en la computadora del equipo. En la carpeta
          del proyecto: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">npm run agente</code>
        </p>
        <a href={DOCS_AGENTE} target="_blank" rel="noreferrer" className="text-xs text-[#1E427C] hover:underline">
          Cómo instalarlo y dejarlo corriendo solo ↗
        </a>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════
// FORMULARIO
// ════════════════════════════════════════════

function FormularioCorrida({
  estado,
  hayAgente,
  onEncolada,
}: {
  estado: Estado
  hayAgente: boolean
  onEncolada: (id: string | null) => void
}) {
  const { catalogo, limites } = estado
  const [modo, setModo] = useState<'todos' | 'zonas'>('todos')
  const [provincias, setProvincias] = useState<string[]>([])
  const [incluirNacionales, setIncluirNacionales] = useState(true)
  const [incluirNoVerificados, setIncluirNoVerificados] = useState(false)
  const [foco, setFoco] = useState('')
  const [maxNoticias, setMaxNoticias] = useState(limites.maxNoticias.porDefecto)
  const [dryRun, setDryRun] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null)

  const medios = useMemo(() => {
    if (modo === 'todos') return null
    const lista: string[] = []
    for (const p of catalogo.provincias) {
      if (!provincias.includes(p.provincia)) continue
      for (const m of p.medios) if (m.activo || incluirNoVerificados) lista.push(m.nombre)
    }
    if (incluirNacionales) lista.push(...catalogo.nacionales.map(n => n.nombre))
    return lista
  }, [modo, provincias, incluirNacionales, incluirNoVerificados, catalogo])

  const focoItems = foco.split(',').map(s => s.trim()).filter(Boolean)
  const invalido =
    (modo === 'zonas' && (provincias.length === 0 || (medios?.length ?? 0) === 0)) ||
    focoItems.length > limites.foco.items

  const alternar = (p: string) =>
    setProvincias(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]))

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    if (invalido || enviando) return
    setEnviando(true)
    setMensaje(null)
    try {
      const body = {
        ...(modo === 'zonas' ? { provincias, incluirNacionales, incluirNoVerificados } : {}),
        foco: focoItems,
        maxNoticias,
        dryRun,
      }
      const r = await fetch('/api/admin/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        const detalle = Array.isArray(d.detalle) ? `: ${d.detalle.join('; ')}` : ''
        setMensaje({ tipo: 'error', texto: `${d.error ?? `Error ${r.status}`}${detalle}` })
        return
      }
      setMensaje({
        tipo: 'ok',
        texto: hayAgente
          ? 'Corrida encolada. El agente la toma en unos segundos.'
          : 'Corrida encolada. Va a empezar cuando se conecte el agente.',
      })
      onEncolada(d.id ?? null)
    } catch {
      setMensaje({ tipo: 'error', texto: 'No se pudo conectar con el servidor.' })
    } finally {
      setEnviando(false)
    }
  }

  return (
    <form onSubmit={enviar} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-gray-600 mb-1">Alcance</legend>
        <div className="grid sm:grid-cols-2 gap-2">
          {([
            ['todos', 'Todos los medios activos', `${catalogo.totalActivos} medios · la corrida de todos los días`],
            ['zonas', 'Enfocar en zonas', 'Elegí provincias donde hay conflictos serios'],
          ] as const).map(([valor, titulo, sub]) => (
            <label
              key={valor}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                modo === valor ? 'border-[#1E427C] bg-blue-50/50' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="modo"
                value={valor}
                checked={modo === valor}
                onChange={() => setModo(valor)}
                className="mt-1 accent-[#1E427C]"
              />
              <span>
                <span className="block text-sm font-medium text-gray-800">{titulo}</span>
                <span className="block text-xs text-gray-500">{sub}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {modo === 'zonas' && (
        <div className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">Provincias</p>
            <div className="flex flex-wrap gap-2">
              {catalogo.provincias.map(p => {
                const activa = provincias.includes(p.provincia)
                return (
                  <button
                    key={p.provincia}
                    type="button"
                    onClick={() => alternar(p.provincia)}
                    aria-pressed={activa}
                    className={`min-h-[40px] text-xs font-medium px-3 py-2 rounded-lg border transition-colors ${
                      activa
                        ? 'border-[#1E427C] bg-[#1E427C] text-white'
                        : 'border-gray-200 text-gray-600 hover:border-[#1E427C] hover:text-[#1E427C]'
                    }`}
                  >
                    {p.provincia}
                    <span className={`ml-1.5 ${activa ? 'text-blue-100' : 'text-gray-400'}`}>
                      {p.activos}{p.noVerificados > 0 ? ` (+${p.noVerificados})` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">
              El número es la cantidad de medios activos; entre paréntesis, los que todavía no se verificaron.
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={incluirNacionales} onChange={e => setIncluirNacionales(e.target.checked)} className="mt-1 accent-[#1E427C]" />
              <span>
                Sumar medios nacionales
                <span className="block text-xs text-gray-500">{catalogo.nacionales.map(n => n.nombre).join(', ') || 'ninguno activo'}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={incluirNoVerificados} onChange={e => setIncluirNoVerificados(e.target.checked)} className="mt-1 accent-[#1E427C]" />
              <span>
                Incluir medios no verificados de esas provincias
                <span className="block text-xs text-gray-500">Amplía la cobertura de la zona, pero algunos pueden estar caídos o cambiar de formato.</span>
              </span>
            </label>
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-semibold text-gray-600">Localidades a priorizar <span className="font-normal text-gray-400">(opcional)</span></span>
          <input
            type="text"
            value={foco}
            onChange={e => setFoco(e.target.value)}
            placeholder="Ej.: Rosario, Villa Gobernador Gálvez"
            maxLength={limites.foco.items * (limites.foco.largo + 2)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#1E427C]/30 focus:border-[#1E427C]"
          />
          <span className="block text-[11px] text-gray-400 mt-1">
            Separadas por comas (hasta {limites.foco.items}). La IA lista primero las noticias de esas zonas; sirve sobre todo con medios nacionales.
          </span>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-gray-600">Notas por medio</span>
          <select
            value={maxNoticias}
            onChange={e => setMaxNoticias(Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1E427C]/30 focus:border-[#1E427C]"
          >
            {[5, 10, 15, 20, 25].filter(n => n >= limites.maxNoticias.min && n <= limites.maxNoticias.max).map(n => (
              <option key={n} value={n}>{n}{n === limites.maxNoticias.porDefecto ? ' (habitual)' : ''}</option>
            ))}
          </select>
          <span className="block text-[11px] text-gray-400 mt-1">Más notas = más cobertura y una corrida más larga.</span>
        </label>
      </div>

      <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="mt-1 accent-[#1E427C]" />
        <span>
          Modo prueba
          <span className="block text-xs text-gray-500">Recorre y analiza todo, pero no guarda nada en la base ni en el mapa.</span>
        </span>
      </label>

      {medios && (
        <p className="text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
          {medios.length === 0
            ? 'Elegí al menos una provincia.'
            : <>Se van a revisar <strong>{medios.length}</strong> medio{medios.length === 1 ? '' : 's'}: {medios.join(', ')}.</>}
        </p>
      )}
      {focoItems.length > limites.foco.items && (
        <p className="text-xs text-red-600">Máximo {limites.foco.items} localidades.</p>
      )}

      {!hayAgente && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          No hay ningún agente conectado: la corrida va a quedar en cola hasta que se inicie en la computadora del equipo.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={invalido || enviando}
          className="min-h-[44px] px-5 py-2.5 rounded-lg bg-[#1E427C] text-white text-sm font-semibold hover:bg-[#16335f] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {enviando ? 'Encolando…' : hayAgente ? 'Iniciar corrida' : 'Encolar corrida'}
        </button>
        {mensaje && (
          <p role="status" className={`text-xs ${mensaje.tipo === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
            {mensaje.texto}
          </p>
        )}
      </div>
    </form>
  )
}

// ════════════════════════════════════════════
// CORRIDA EN CURSO
// ════════════════════════════════════════════

async function pedirCancelacion(id: string): Promise<string | null> {
  if (!window.confirm('¿Cancelar esta corrida? Lo que ya se guardó queda guardado.')) return null
  try {
    const r = await fetch(`/api/admin/pipeline/${id}/cancelar`, { method: 'POST' })
    const d = await r.json().catch(() => ({}))
    return r.ok ? null : (d.error ?? `Error ${r.status}`)
  } catch {
    return 'No se pudo conectar con el servidor.'
  }
}

function EnCurso({ corrida, ahora, onVer, onCambio }: {
  corrida: Corrida
  ahora: number
  onVer: () => void
  onCambio: () => void
}) {
  const p = corrida.progreso
  const porcentaje = p && p.totalMedios > 0
    ? Math.round(((Math.max(0, p.medioIndice - 1) + (p.fase === 'finalizando' ? 1 : 0.5)) / p.totalMedios) * 100)
    : 0
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-gray-800">
            {alcance(corrida.parametros)}
            {corrida.parametros.dryRun && <span className="ml-2 text-[11px] text-amber-700 font-semibold">PRUEBA</span>}
          </p>
          <p className="text-xs text-gray-500">
            {ORIGENES[corrida.origen]} · en {corrida.agente ?? '—'} · empezó {fechaHora(corrida.iniciadaAt)} · lleva {duracion(corrida.iniciadaAt, null, ahora)}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onVer} className="min-h-[40px] text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:border-[#1E427C] hover:text-[#1E427C]">
            Ver log
          </button>
          <button
            type="button"
            disabled={corrida.cancelacionSolicitada}
            onClick={async () => { setError(await pedirCancelacion(corrida.id)); onCambio() }}
            className="min-h-[40px] text-xs font-medium px-3 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {corrida.cancelacionSolicitada ? 'Cancelando…' : 'Cancelar'}
          </button>
        </div>
      </div>

      {corrida.sinLatido && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Sin señal del agente desde {haceCuanto(corrida.latidoAt, ahora)}: la computadora pudo apagarse o suspenderse.
        </p>
      )}

      <div>
        <div className="flex justify-between text-xs text-gray-600 mb-1">
          <span>
            {p ? FASES[p.fase] ?? p.fase : 'Arrancando'}
            {p?.medio ? ` · ${p.medio}` : ''}
          </span>
          {p && p.totalMedios > 0 && <span>Medio {Math.max(1, p.medioIndice)} de {p.totalMedios}</span>}
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden" role="progressbar" aria-valuenow={porcentaje} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-[#1E427C] rounded-full transition-all duration-500" style={{ width: `${porcentaje}%` }} />
        </div>
      </div>

      {p && <Contadores c={p.contadores} />}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

// ════════════════════════════════════════════
// DETALLE + LOG
// ════════════════════════════════════════════

function Detalle({ id, onCerrar }: { id: string; onCerrar: () => void }) {
  const [corrida, setCorrida] = useState<Corrida | null>(null)
  const [lineas, setLineas] = useState<Linea[]>([])
  const [error, setError] = useState<string | null>(null)
  const ultimaRef = useRef(0)
  const cajaRef = useRef<HTMLDivElement>(null)
  const pegadoAbajoRef = useRef(true)

  useEffect(() => {
    let vivo = true
    let terminada = false
    ultimaRef.current = 0
    setLineas([])
    setCorrida(null)

    async function traer() {
      try {
        const r = await fetch(`/api/admin/pipeline/${id}?desde=${ultimaRef.current}`, { cache: 'no-store' })
        const d = await r.json()
        if (!vivo) return
        if (!r.ok) { setError(d.error ?? `Error ${r.status}`); return }
        setError(null)
        setCorrida(d.corrida)
        if (d.lineas.length > 0) {
          ultimaRef.current = d.lineas[d.lineas.length - 1].id
          setLineas(prev => [...prev, ...d.lineas].slice(-3000))
        }
        const final = !['pendiente', 'en_curso'].includes(d.corrida.estado)
        if (d.hayMas) void traer()
        else if (final) terminada = true
      } catch {
        if (vivo) setError('No se pudo actualizar el log. Reintentando…')
      }
    }

    void traer()
    const t = setInterval(() => {
      if (!terminada && document.visibilityState === 'visible') void traer()
    }, 3000)
    return () => { vivo = false; clearInterval(t) }
  }, [id])

  // Autoscroll mientras la persona no haya subido a leer algo.
  useEffect(() => {
    const caja = cajaRef.current
    if (caja && pegadoAbajoRef.current) caja.scrollTop = caja.scrollHeight
  }, [lineas])

  useEffect(() => {
    const cerrarConEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar() }
    window.addEventListener('keydown', cerrarConEscape)
    return () => window.removeEventListener('keydown', cerrarConEscape)
  }, [onCerrar])

  const r = corrida?.resumen
  const problemas = r?.medios?.filter(m => m.problema) ?? []

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onCerrar}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Detalle de la corrida"
        className="bg-white w-full sm:max-w-3xl max-h-[92dvh] rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {corrida && <Insignia estado={corrida.estado} />}
              <span className="text-sm font-semibold text-gray-800 truncate">
                {corrida ? alcance(corrida.parametros) : 'Cargando…'}
              </span>
            </div>
            {corrida && (
              <p className="text-xs text-gray-500 mt-0.5">
                {ORIGENES[corrida.origen]}{corrida.solicitadaPor ? ` · ${corrida.solicitadaPor}` : ''} · {fechaHora(corrida.creadaAt)}
                {corrida.agente ? ` · ${corrida.agente}` : ''}
              </p>
            )}
          </div>
          <button type="button" onClick={onCerrar} aria-label="Cerrar" className="min-w-[40px] min-h-[40px] rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {corrida?.error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 break-words">{corrida.error}</p>
          )}
          {r && <Contadores c={r} />}
          {problemas.length > 0 && (
            <div className="text-xs text-gray-600">
              <p className="font-semibold text-gray-700 mb-1">Medios con problemas</p>
              <ul className="space-y-0.5">
                {problemas.map(m => <li key={m.medio}><strong>{m.medio}:</strong> {m.problema}</li>)}
              </ul>
            </div>
          )}
          {r?.perfilLLM && <p className="text-[11px] text-gray-400">Modelo: {r.perfilLLM}</p>}

          <div>
            <p className="text-xs font-semibold text-gray-700 mb-1">Log</p>
            <div
              ref={cajaRef}
              onScroll={e => {
                const c = e.currentTarget
                pegadoAbajoRef.current = c.scrollHeight - c.scrollTop - c.clientHeight < 40
              }}
              className="bg-gray-900 text-gray-100 rounded-lg p-3 h-[45dvh] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
            >
              {lineas.length === 0
                ? <span className="text-gray-400">{corrida?.estado === 'pendiente' ? 'Esperando a que el agente la tome…' : 'Sin líneas todavía.'}</span>
                : lineas.map(l => <div key={l.id}>{l.texto}</div>)}
            </div>
            {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════
// PÁGINA
// ════════════════════════════════════════════

export default function PanelPipeline() {
  const [estado, setEstado] = useState<Estado | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detalle, setDetalle] = useState<string | null>(null)
  const [ahora, setAhora] = useState(() => Date.now())

  const cargar = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/pipeline', { cache: 'no-store' })
      if (r.status === 401) {
        setError('Tu sesión venció o ya no tenés acceso. Volvé a ingresar.')
        return
      }
      const d = await r.json()
      if (!r.ok) { setError(d.error ?? `Error ${r.status}`); return }
      setEstado(d)
      setError(null)
    } catch {
      setError('No se pudo conectar con el servidor. Reintentando…')
    }
  }, [])

  const hayActividad = estado?.corridas.some(c => c.estado === 'pendiente' || c.estado === 'en_curso') ?? false

  useEffect(() => {
    void cargar()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void cargar()
    }, hayActividad ? 4000 : 20000)
    return () => clearInterval(t)
  }, [cargar, hayActividad])

  // Reloj para "hace X s" y duraciones, sin volver a pedir datos.
  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const enCurso = estado?.corridas.filter(c => c.estado === 'en_curso') ?? []
  const pendientes = estado?.corridas.filter(c => c.estado === 'pendiente') ?? []
  const historial = estado?.corridas.filter(c => c.estado !== 'en_curso' && c.estado !== 'pendiente') ?? []
  const hayAgente = estado?.agentes.some(a => a.conectado) ?? false

  return (
    <div className="min-h-screen bg-gray-50">
      <AdminNav />

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        <div>
          <h1 className="text-lg font-bold text-[#1E427C]">Control del pipeline</h1>
          <p className="text-xs text-gray-500">
            Las corridas se ejecutan en la computadora del equipo con el agente local. GitHub Actions queda de respaldo
            si ese día no corrió la programada.
          </p>
        </div>

        {error && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <span>{error}</span>
            {error.includes('sesión')
              ? <a href="/admin/login" className="text-xs font-semibold underline">Ingresar</a>
              : <button type="button" onClick={() => void cargar()} className="text-xs font-semibold underline">Reintentar</button>}
          </div>
        )}

        {!estado && !error && (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-[#1E427C] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {estado && (
          <>
            <Tarjeta titulo="Agente local">
              <EstadoAgente agentes={estado.agentes} corridas={estado.corridas} ahora={ahora} />
            </Tarjeta>

            {enCurso.map(c => (
              <Tarjeta key={c.id} titulo="Corrida en curso" accion={<Insignia estado="en_curso" />}>
                <EnCurso corrida={c} ahora={ahora} onVer={() => setDetalle(c.id)} onCambio={() => void cargar()} />
              </Tarjeta>
            ))}

            {pendientes.length > 0 && (
              <Tarjeta titulo={`En cola (${pendientes.length})`}>
                <ul className="divide-y divide-gray-100">
                  {pendientes.map(c => (
                    <li key={c.id} className="py-2 flex items-center justify-between gap-3">
                      <button type="button" onClick={() => setDetalle(c.id)} className="text-left min-w-0">
                        <span className="block text-sm text-gray-800 truncate">{alcance(c.parametros)}</span>
                        <span className="block text-xs text-gray-500">
                          {ORIGENES[c.origen]} · encolada {haceCuanto(c.creadaAt, ahora)}{c.parametros.dryRun ? ' · prueba' : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => { const e = await pedirCancelacion(c.id); if (e) setError(e); void cargar() }}
                        className="min-h-[40px] text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-700 shrink-0"
                      >
                        Cancelar
                      </button>
                    </li>
                  ))}
                </ul>
              </Tarjeta>
            )}

            <Tarjeta titulo="Nueva corrida">
              <FormularioCorrida
                estado={estado}
                hayAgente={hayAgente}
                onEncolada={id => { void cargar(); if (id) setDetalle(id) }}
              />
            </Tarjeta>

            <Tarjeta titulo="Historial" accion={<span className="text-[11px] text-gray-400">últimas {estado.corridas.length}</span>}>
              {historial.length === 0 ? (
                <p className="text-sm text-gray-500">Todavía no hay corridas registradas.</p>
              ) : (
                <ul className="divide-y divide-gray-100 -my-2">
                  {historial.map(c => {
                    const r = c.resumen
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setDetalle(c.id)}
                          className="w-full text-left py-2.5 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 hover:bg-gray-50 rounded-lg px-1"
                        >
                          <span className="text-xs text-gray-500 w-24 shrink-0">{fechaHora(c.creadaAt)}</span>
                          <Insignia estado={c.estado} />
                          <span className="text-xs text-gray-400 shrink-0">{ORIGENES[c.origen]}</span>
                          <span className="text-sm text-gray-700 truncate flex-1 min-w-[40%]">
                            {alcance(c.parametros)}{c.parametros.dryRun ? ' · prueba' : ''}
                          </span>
                          <span className={`text-xs shrink-0 max-w-full sm:max-w-[45%] truncate ${c.estado === 'fallida' ? 'text-red-600' : 'text-gray-500'}`}>
                            {c.estado === 'completada' && r
                              ? `${r.hechosNuevos} nuevos · ${r.coberturasVinculadas} cob.`
                              : c.estado === 'fallida' && c.error
                                ? c.error
                                : c.estado === 'cancelada' ? 'cancelada' : ''}
                            {' · '}{duracion(c.iniciadaAt, c.finalizadaAt, ahora)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Tarjeta>
          </>
        )}
      </main>

      {detalle && <Detalle id={detalle} onCerrar={() => setDetalle(null)} />}
    </div>
  )
}
