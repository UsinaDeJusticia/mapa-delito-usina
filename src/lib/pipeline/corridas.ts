/**
 * Corridas del pipeline: cola, historial, latidos y el protocolo de eventos
 * entre scrapear-medios.ts y el agente local.
 *
 * QUIÉN USA ESTO
 * - El panel /admin/pipeline encola corridas y lee el estado.
 * - El agente local (scripts/pipeline/agente-local.ts) toma corridas de la
 *   cola, las ejecuta en la computadora del equipo y va dejando latido,
 *   progreso y log.
 * - scrapear-medios.ts, cuando corre solo (GitHub Actions o línea de
 *   comandos), se registra acá para que el historial sea uno solo.
 *
 * Todo el acceso a las tablas pasa por estas funciones, que reciben el cliente
 * de Prisma por parámetro: en la app y en los scripts es el singleton de
 * src/lib/mapa/queries.ts, y así ninguna de las dos puntas instancia otro.
 */

import type { CorridaPipeline, Prisma, PrismaClient } from '@prisma/client'
import type { ResumenSaludLLM } from './salud-llm'
import { minutosDelDiaArgentina } from './fechas'

export const ESTADOS_CORRIDA = ['pendiente', 'en_curso', 'completada', 'fallida', 'cancelada'] as const
export type EstadoCorrida = (typeof ESTADOS_CORRIDA)[number]

export const ORIGENES_CORRIDA = ['panel', 'programada', 'github-actions', 'cli'] as const
export type OrigenCorrida = (typeof ORIGENES_CORRIDA)[number]

export function esOrigenValido(v: string | undefined): v is OrigenCorrida {
  return (ORIGENES_CORRIDA as readonly string[]).includes(v ?? '')
}

/** Un agente sin latido hace más que esto se muestra como desconectado. */
export const AGENTE_VIVO_MS = 2 * 60 * 1000

/**
 * Una corrida `en_curso` sin latido hace más que esto se considera
 * interrumpida (la computadora se apagó o se durmió, se cortó la luz...).
 */
export const CORRIDA_COLGADA_MS = 10 * 60 * 1000

/** Largo máximo de una línea de log guardada: una línea desbocada no llena la tabla. */
export const MAX_CHARS_LINEA = 2000

// ════════════════════════════════════════════
// PROTOCOLO DE EVENTOS (script → agente)
// ════════════════════════════════════════════
//
// scrapear-medios.ts imprime, además de su log para humanos, líneas con este
// prefijo y un JSON de una sola línea. El agente las intercepta para actualizar
// la barra de progreso y el resumen del panel sin tener que parsear el log
// libre (que es lo que hacía pipeline-runner.ts con una regex sobre "Resumen:").

export const PREFIJO_EVENTO = '@@PIPELINE@@ '

export type FaseCorrida =
  | 'preparando'
  | 'verificando-llm'
  | 'navegando'
  | 'identificando'
  | 'extrayendo'
  | 'finalizando'

export interface ContadoresCorrida {
  noticiasScrapeadas: number
  hechosExtraidos: number
  hechosNuevos: number
  coberturasVinculadas: number
  duplicados: number
  descartados: number
}

export interface ProgresoCorrida {
  totalMedios: number
  /** 1-based; 0 = todavía no empezó con ningún medio. */
  medioIndice: number
  medio: string | null
  fase: FaseCorrida
  contadores: ContadoresCorrida
}

export interface ResultadoMedio {
  medio: string
  identificadas: number
  extraidas: number
  /** Motivo si el medio no se pudo procesar (sin snapshot, sin respuesta del LLM...). */
  problema?: string
}

export interface ResumenCorrida extends ContadoresCorrida {
  modo: 'DRY RUN' | 'PRODUCCIÓN'
  /**
   * ok = corrió y el LLM respondió; fallida = no se puede confiar en el
   * resultado (proveedor caído, corrida abortada). Es lo que define el código
   * de salida del proceso.
   */
  estado: 'ok' | 'fallida'
  motivoFallo?: string
  perfilLLM: string
  llm: ResumenSaludLLM
  medios: ResultadoMedio[]
  tiemposMs: Record<string, number>
  llamadasLLM: Record<string, number>
}

export type EventoPipeline =
  | { tipo: 'progreso'; progreso: ProgresoCorrida }
  | { tipo: 'resumen'; resumen: ResumenCorrida }

export function formatearEvento(evento: EventoPipeline): string {
  return PREFIJO_EVENTO + JSON.stringify(evento)
}

/** null si la línea no es un evento (o es uno mal formado: se trata como log común). */
export function parsearEvento(linea: string): EventoPipeline | null {
  const i = linea.indexOf(PREFIJO_EVENTO)
  if (i === -1) return null
  try {
    const valor = JSON.parse(linea.slice(i + PREFIJO_EVENTO.length)) as Partial<EventoPipeline>
    if (valor?.tipo === 'progreso' && valor.progreso && typeof valor.progreso === 'object') {
      return valor as EventoPipeline
    }
    if (valor?.tipo === 'resumen' && valor.resumen && typeof valor.resumen === 'object') {
      return valor as EventoPipeline
    }
  } catch {
    // no era JSON válido
  }
  return null
}

// ════════════════════════════════════════════
// REGLAS PURAS
// ════════════════════════════════════════════

export function claveProgramada(fecha: string): string {
  return `programada:${fecha}`
}

/** 'HH:MM' → minutos desde medianoche. null si el formato no sirve. */
export function minutosDeHora(hora: string): number | null {
  const m = hora.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * ¿Ya es hora de la corrida programada de hoy? Si la computadora estuvo
 * apagada a la hora exacta, se recupera apenas el agente arranca: lo que evita
 * repetirla es la clave única del día, no la hora.
 */
export function yaEsHoraDeProgramada(horaProgramada: string, ahora: Date = new Date()): boolean {
  const objetivo = minutosDeHora(horaProgramada)
  if (objetivo === null) return false
  return minutosDelDiaArgentina(ahora) >= objetivo
}

/**
 * Estado final de una corrida a partir de cómo terminó el proceso.
 * Un proceso que sale con 0 pero sin resumen murió de forma rara: no se
 * reporta como completada, que es justo el error que se quiere evitar.
 */
export function estadoFinal(
  exitCode: number | null,
  cancelada: boolean,
  resumen: ResumenCorrida | null
): { estado: EstadoCorrida; error: string | null } {
  if (cancelada) return { estado: 'cancelada', error: 'cancelada desde el panel' }
  if (exitCode === 0 && resumen?.estado === 'ok') return { estado: 'completada', error: null }
  if (resumen?.estado === 'fallida') {
    return { estado: 'fallida', error: resumen.motivoFallo ?? 'el pipeline reportó una falla' }
  }
  if (exitCode === 0) return { estado: 'fallida', error: 'el proceso terminó sin emitir el resumen' }
  return { estado: 'fallida', error: `el proceso terminó con código ${exitCode ?? 'desconocido'}` }
}

// ════════════════════════════════════════════
// ACCESO A LA BASE
// ════════════════════════════════════════════

type Db = Pick<PrismaClient, 'corridaPipeline' | 'corridaPipelineLinea' | 'agentePipeline'>

function esErrorDeUnicidad(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'P2002'
}

export async function encolarCorrida(
  db: Db,
  datos: {
    origen: OrigenCorrida
    parametros: object
    solicitadaPor?: string | null
    claveUnica?: string | null
    /** Para las corridas que se registran ya empezadas (Actions, CLI). */
    enCursoPor?: string
  }
): Promise<CorridaPipeline | null> {
  const ahora = new Date()
  try {
    return await db.corridaPipeline.create({
      data: {
        origen: datos.origen,
        parametros: datos.parametros as Prisma.InputJsonValue,
        solicitadaPor: datos.solicitadaPor ?? null,
        claveUnica: datos.claveUnica ?? null,
        ...(datos.enCursoPor
          ? { estado: 'en_curso', agente: datos.enCursoPor, iniciadaAt: ahora, latidoAt: ahora }
          : {}),
      },
    })
  } catch (error) {
    // La clave del día ya existe: otra punta ya se encargó de la programada.
    if (esErrorDeUnicidad(error)) return null
    throw error
  }
}

/**
 * Toma la corrida pendiente más vieja.
 *
 * El `updateMany` condicionado a `estado = 'pendiente'` hace de candado: si dos
 * agentes eligen la misma fila, Postgres serializa los dos UPDATE y solo uno
 * ve la condición verdadera. El otro recibe count 0 y prueba con la siguiente.
 */
export async function tomarSiguienteCorrida(db: Db, agente: string): Promise<CorridaPipeline | null> {
  for (let intento = 0; intento < 5; intento++) {
    const candidata = await db.corridaPipeline.findFirst({
      where: { estado: 'pendiente' },
      orderBy: { creadaAt: 'asc' },
    })
    if (!candidata) return null

    const ahora = new Date()
    if (candidata.cancelacionSolicitada) {
      await db.corridaPipeline.updateMany({
        where: { id: candidata.id, estado: 'pendiente' },
        data: { estado: 'cancelada', finalizadaAt: ahora, error: 'cancelada antes de empezar' },
      })
      continue
    }

    const { count } = await db.corridaPipeline.updateMany({
      where: { id: candidata.id, estado: 'pendiente' },
      data: { estado: 'en_curso', agente, iniciadaAt: ahora, latidoAt: ahora },
    })
    if (count === 1) {
      return { ...candidata, estado: 'en_curso', agente, iniciadaAt: ahora, latidoAt: ahora }
    }
  }
  return null
}

/** Latido de una corrida en curso. Devuelve si el panel pidió cancelarla. */
export async function latidoCorrida(
  db: Db,
  id: string,
  progreso?: ProgresoCorrida | null
): Promise<{ cancelar: boolean }> {
  const fila = await db.corridaPipeline.update({
    where: { id },
    data: {
      latidoAt: new Date(),
      ...(progreso ? { progreso: progreso as unknown as Prisma.InputJsonValue } : {}),
    },
    select: { cancelacionSolicitada: true },
  })
  return { cancelar: fila.cancelacionSolicitada }
}

export async function agregarLineas(db: Db, corridaId: string, lineas: readonly string[]): Promise<void> {
  if (lineas.length === 0) return
  await db.corridaPipelineLinea.createMany({
    data: lineas.map(texto => ({ corridaId, texto: texto.slice(0, MAX_CHARS_LINEA) })),
  })
}

export async function finalizarCorrida(
  db: Db,
  id: string,
  datos: {
    estado: EstadoCorrida
    resumen?: ResumenCorrida | null
    progreso?: ProgresoCorrida | null
    error?: string | null
    exitCode?: number | null
  }
): Promise<void> {
  const ahora = new Date()
  await db.corridaPipeline.update({
    where: { id },
    data: {
      estado: datos.estado,
      finalizadaAt: ahora,
      latidoAt: ahora,
      error: datos.error ? datos.error.slice(0, 2000) : null,
      exitCode: datos.exitCode ?? null,
      ...(datos.resumen ? { resumen: datos.resumen as unknown as Prisma.InputJsonValue } : {}),
      ...(datos.progreso ? { progreso: datos.progreso as unknown as Prisma.InputJsonValue } : {}),
    },
  })
}

/**
 * Pide cancelar. Una pendiente se cancela en el acto; una en curso queda
 * marcada y el agente la corta en su próximo latido (cada pocos segundos).
 */
export async function solicitarCancelacion(
  db: Db,
  id: string
): Promise<'cancelada' | 'solicitada' | 'no-cancelable' | 'no-existe'> {
  const corrida = await db.corridaPipeline.findUnique({ where: { id }, select: { estado: true } })
  if (!corrida) return 'no-existe'
  if (corrida.estado === 'pendiente') {
    const { count } = await db.corridaPipeline.updateMany({
      where: { id, estado: 'pendiente' },
      data: { estado: 'cancelada', cancelacionSolicitada: true, finalizadaAt: new Date(), error: 'cancelada antes de empezar' },
    })
    if (count === 1) return 'cancelada'
  }
  const { count } = await db.corridaPipeline.updateMany({
    where: { id, estado: 'en_curso' },
    data: { cancelacionSolicitada: true },
  })
  return count === 1 ? 'solicitada' : 'no-cancelable'
}

/**
 * Al arrancar, un agente cierra las corridas que quedaron a su nombre en curso:
 * si él se está iniciando, esas corridas no las está ejecutando nadie.
 */
export async function cerrarHuerfanas(db: Db, agente: string): Promise<number> {
  const { count } = await db.corridaPipeline.updateMany({
    where: { estado: 'en_curso', agente },
    data: {
      estado: 'fallida',
      finalizadaAt: new Date(),
      error: 'el agente se reinició mientras la corrida estaba en curso',
    },
  })
  return count
}

export async function latidoAgente(db: Db, nombre: string, info: object): Promise<void> {
  const ahora = new Date()
  await db.agentePipeline.upsert({
    where: { nombre },
    create: { nombre, latidoAt: ahora, info: info as Prisma.InputJsonValue },
    update: { latidoAt: ahora, info: info as Prisma.InputJsonValue },
  })
}

/** Las líneas de log son lo único que crece rápido: se guardan 30 días. */
export async function limpiarLineasViejas(db: Db, dias = 30): Promise<number> {
  const limite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000)
  const { count } = await db.corridaPipelineLinea.deleteMany({ where: { ts: { lt: limite } } })
  return count
}

/**
 * ¿La programada del día ya está cubierta, o tiene que correr el respaldo de
 * GitHub Actions?
 *
 * Cubierta: completada, en curso con latido reciente, o pendiente con algún
 * agente vivo que la va a tomar. Una pendiente sin agente vivo no cubre nada:
 * el agente la encoló y se apagó antes de tomarla (o lo cerraron con otras
 * corridas delante), y darla por buena dejaba el día sin corrida. Una en curso
 * sin latido se trata como interrumpida (la computadora se apagó a mitad).
 */
export function evaluarProgramada(
  corrida: Pick<CorridaPipeline, 'estado' | 'origen' | 'agente' | 'latidoAt'> | null,
  agenteVivo: boolean,
  ahora: Date = new Date()
): { cubierta: boolean; detalle: string } {
  if (!corrida) return { cubierta: false, detalle: 'no hubo corrida programada hoy' }
  switch (corrida.estado) {
    case 'completada':
      return { cubierta: true, detalle: `la programada de hoy está completada (${corrida.origen})` }
    case 'pendiente':
      return agenteVivo
        ? { cubierta: true, detalle: 'la programada de hoy está en cola y hay un agente conectado' }
        : { cubierta: false, detalle: 'la programada de hoy quedó en cola sin ningún agente conectado' }
    case 'en_curso': {
      const latido = corrida.latidoAt?.getTime() ?? 0
      return ahora.getTime() - latido < CORRIDA_COLGADA_MS
        ? { cubierta: true, detalle: `la programada de hoy está en curso en ${corrida.agente ?? 'otro agente'}` }
        : { cubierta: false, detalle: 'la programada de hoy quedó en curso sin latido' }
    }
    default:
      return { cubierta: false, detalle: `la programada de hoy terminó ${corrida.estado}` }
  }
}

/** ¿Algún agente dio señales hace menos de AGENTE_VIVO_MS? Late también mientras ejecuta. */
export async function hayAgenteVivo(db: Db, ahora: Date = new Date()): Promise<boolean> {
  const vivo = await db.agentePipeline.findFirst({
    where: { latidoAt: { gte: new Date(ahora.getTime() - AGENTE_VIVO_MS) } },
    select: { nombre: true },
  })
  return vivo !== null
}

export type DecisionRespaldo =
  | { correr: false; detalle: string }
  | { correr: true; corridaId: string | null; detalle: string }

/**
 * El respaldo de Actions decide si corre y, si corre, con qué fila del
 * historial.
 *
 * Entre la consulta y el alta puede aparecer el agente (la computadora se
 * prende justo a esa hora). En vez de sumar una corrida en paralelo, se vuelve
 * a leer la fila del día y se decide de nuevo. Una programada pendiente sin
 * agente la toma el respaldo con el mismo candado que usa el agente
 * (`updateMany` condicionado al estado): nunca la corren los dos.
 */
export async function tomarProgramadaParaRespaldo(
  db: Db,
  fecha: string,
  datos: { origen: OrigenCorrida; parametros: object; agente: string }
): Promise<DecisionRespaldo> {
  const claveUnica = claveProgramada(fecha)
  for (let intento = 0; intento < 3; intento++) {
    const existente = await db.corridaPipeline.findUnique({ where: { claveUnica } })

    if (!existente) {
      const creada = await encolarCorrida(db, {
        origen: datos.origen,
        parametros: datos.parametros,
        claveUnica,
        enCursoPor: datos.agente,
      })
      if (creada) return { correr: true, corridaId: creada.id, detalle: 'no hubo corrida programada hoy' }
      continue // el agente la creó en este instante: se vuelve a leer
    }

    const agenteVivo = existente.estado === 'pendiente' && (await hayAgenteVivo(db))
    const { cubierta, detalle } = evaluarProgramada(existente, agenteVivo)
    if (cubierta) return { correr: false, detalle }

    if (existente.estado === 'pendiente') {
      const ahora = new Date()
      const { count } = await db.corridaPipeline.updateMany({
        where: { id: existente.id, estado: 'pendiente' },
        data: {
          estado: 'en_curso',
          agente: datos.agente,
          parametros: datos.parametros as Prisma.InputJsonValue,
          iniciadaAt: ahora,
          latidoAt: ahora,
        },
      })
      if (count === 1) return { correr: true, corridaId: existente.id, detalle: `${detalle}: la toma el respaldo` }
      continue // la tomó un agente en este instante
    }

    // Terminó mal o quedó colgada: el respaldo corre con una fila propia, sin
    // la clave del día (que sigue en la fila original).
    const reemplazo = await encolarCorrida(db, {
      origen: datos.origen,
      parametros: datos.parametros,
      enCursoPor: datos.agente,
    })
    return { correr: true, corridaId: reemplazo?.id ?? null, detalle }
  }
  // La fila del día cambió tres veces mientras se decidía: otra punta la está
  // manejando, y correr en paralelo es peor que no correr.
  return { correr: false, detalle: 'la programada de hoy cambió de estado mientras se consultaba' }
}
