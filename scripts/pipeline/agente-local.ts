/**
 * Agente local del pipeline de medios.
 *
 * Ejecuta en ESTA computadora —con su navegador, su conexión y su CPU— las
 * corridas que se piden desde el panel /admin/pipeline, y la corrida diaria
 * programada. Reemplaza a GitHub Actions como motor principal del scraping:
 * Actions queda de respaldo, y solo corre si el agente no hizo la programada
 * del día (ver .github/workflows/pipeline.yml).
 *
 * Cómo se comunica con el panel: por la base (Neon). El panel encola filas en
 * corridas_pipeline; el agente las toma, lanza scrapear-medios.ts como proceso
 * hijo, y va dejando latido, progreso y log en la misma fila. No abre puertos
 * ni necesita que la computadora sea accesible desde internet.
 *
 * Uso:
 *   npm run agente               # queda escuchando (dejarlo abierto o como servicio)
 *   npm run agente -- --una-vez  # procesa lo pendiente (y la programada si toca) y sale
 *
 * Configuración (.env): ver docs/agente-local.md.
 */

import './cargar-env'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import type { CorridaPipeline } from '@prisma/client'
import { prisma } from '../../src/lib/mapa/queries'
import { MEDIOS } from '../../src/config/medios-pipeline'
import {
  agregarLineas,
  cerrarHuerfanas,
  claveProgramada,
  encolarCorrida,
  estadoFinal,
  finalizarCorrida,
  latidoAgente,
  latidoCorrida,
  limpiarLineasViejas,
  minutosDeHora,
  parsearEvento,
  tomarSiguienteCorrida,
  yaEsHoraDeProgramada,
  type ProgresoCorrida,
  type ResumenCorrida,
} from '../../src/lib/pipeline/corridas'
import {
  argumentosDesdeParametros,
  catalogoPorProvincia,
  describirAlcance,
  PARAMETROS_POR_DEFECTO,
  validarParametros,
  type CatalogoValidacion,
} from '../../src/lib/pipeline/opciones-corrida'
import { fechaArgentina, horaArgentina } from '../../src/lib/pipeline/fechas'
import { getConfigActiva, getNivelRazonamiento } from '../../src/config/modelos-pipeline'
import { comandos, ejecutarBrowser } from '../../src/lib/pipeline/browser-cmd'

// ════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════

const NOMBRE = (process.env.PIPELINE_AGENTE_NOMBRE?.trim() || os.hostname()).slice(0, 60)

/** Hora de la corrida diaria, en hora argentina. "no" la desactiva. */
const HORA_PROGRAMADA = process.env.PIPELINE_AGENTE_HORA?.trim() || '07:00'
const PROGRAMADA_ACTIVA = minutosDeHora(HORA_PROGRAMADA) !== null

const INTERVALO_MS = Math.max(5, Number(process.env.PIPELINE_AGENTE_INTERVALO_S) || 15) * 1000
const UNA_VEZ = process.argv.includes('--una-vez')

/** Cada cuánto se vuelca el log a la base y se manda el latido de la corrida. */
const FLUSH_MS = 3000
/** Tope de líneas guardadas por corrida: un bucle de logs no llena la tabla. */
const MAX_LINEAS_POR_CORRIDA = 20_000
const LATIDO_AGENTE_MS = 30_000

/**
 * El agente manda 10.000 caracteres de snapshot, igual que el workflow: a 3000
 * (el default del código) la mitad de los medios daba cero noticias porque el
 * snapshot solo alcanzaba el menú. Se puede cambiar en el .env.
 */
const SNAPSHOT_MAX_CHARS = process.env.PIPELINE_SNAPSHOT_MAX_CHARS || '10000'

const CATALOGO: CatalogoValidacion = {
  idsMedios: new Set(MEDIOS.map(m => m.id)),
  provincias: catalogoPorProvincia(MEDIOS).map(p => p.provincia),
}

const INICIADO_AT = new Date().toISOString()

// ════════════════════════════════════════════
// ESTADO
// ════════════════════════════════════════════

let deteniendo = false
let corridaActual: { id: string; hijo: ChildProcess; cancelada: boolean } | null = null
let despertar: (() => void) | null = null
let ultimaFechaProgramada: string | null = null

function log(emoji: string, msg: string) {
  console.log(`${emoji} [${horaArgentina()}] [agente] ${msg}`)
}

function dormir(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(() => { despertar = null; resolve() }, ms)
    despertar = () => { clearTimeout(t); despertar = null; resolve() }
  })
}

function infoAgente(): object {
  return {
    plataforma: `${os.platform()} ${os.arch()}`,
    node: process.version,
    horaProgramada: PROGRAMADA_ACTIVA ? HORA_PROGRAMADA : null,
    perfilLLM: getConfigActiva().descripcion,
    razonamiento: getNivelRazonamiento() ?? 'lo decide el proveedor',
    intervaloS: INTERVALO_MS / 1000,
    corridaEnCurso: corridaActual?.id ?? null,
    iniciadoAt: INICIADO_AT,
  }
}

// ════════════════════════════════════════════
// CORRIDA PROGRAMADA
// ════════════════════════════════════════════

/**
 * Encola la corrida del día si ya pasó la hora. Si la computadora estaba
 * apagada a esa hora, la recupera apenas arranca. La clave única del día evita
 * duplicarla aunque haya dos agentes o el respaldo de Actions ya la haya hecho.
 */
async function encolarProgramadaSiCorresponde(): Promise<void> {
  if (!PROGRAMADA_ACTIVA || !yaEsHoraDeProgramada(HORA_PROGRAMADA)) return
  const fecha = fechaArgentina()
  if (ultimaFechaProgramada === fecha) return

  // La programada es la corrida completa de siempre; solo la profundidad se
  // puede ajustar desde el .env. Un valor fuera de rango cae al default.
  const pedido = validarParametros({ maxNoticias: Number(process.env.PIPELINE_MAX_NOTICIAS) || undefined }, CATALOGO)
  const creada = await encolarCorrida(prisma, {
    origen: 'programada',
    parametros: pedido.ok ? pedido.valor : PARAMETROS_POR_DEFECTO,
    claveUnica: claveProgramada(fecha),
    solicitadaPor: `agente:${NOMBRE}`,
  })
  ultimaFechaProgramada = fecha
  if (creada) log('🗓️', `Corrida programada del ${fecha} encolada`)
}

// ════════════════════════════════════════════
// EJECUCIÓN DE UNA CORRIDA
// ════════════════════════════════════════════

function rutaTsx(): string {
  try {
    return require.resolve('tsx/cli')
  } catch {
    return path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  }
}

/** Mata el proceso hijo y todo lo que haya lanzado (tsx lanza su propio Node). */
function matar(hijo: ChildProcess): void {
  if (hijo.exitCode !== null || !hijo.pid) return
  if (process.platform === 'win32') {
    // En Windows kill() solo termina el proceso directo: taskkill /T baja el árbol.
    spawn('taskkill', ['/pid', String(hijo.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-hijo.pid, 'SIGTERM') // grupo de procesos: el hijo corre con detached
  } catch {
    hijo.kill('SIGTERM')
  }
  const pid = hijo.pid
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* ya terminó */ }
  }, 15_000).unref()
}

async function ejecutarCorrida(corrida: CorridaPipeline): Promise<void> {
  const corto = corrida.id.slice(0, 8)

  // Se vuelve a validar lo que viene de la base aunque el panel ya lo haya
  // validado: esta computadora ejecuta procesos a partir de esa fila.
  const validacion = validarParametros(corrida.parametros, CATALOGO)
  if (!validacion.ok) {
    log('❌', `Corrida ${corto} con parámetros inválidos: ${validacion.errores.join('; ')}`)
    await finalizarCorrida(prisma, corrida.id, {
      estado: 'fallida',
      error: `parámetros inválidos: ${validacion.errores.join('; ')}`,
    })
    return
  }
  const parametros = validacion.valor
  const sesionBrowser = `usina-corrida-${corto}`

  log('▶️', `Corrida ${corto} (${corrida.origen}${corrida.solicitadaPor ? `, ${corrida.solicitadaPor}` : ''}): ${describirAlcance(parametros)}${parametros.dryRun ? ' · PRUEBA' : ''}`)

  const hijo = spawn(
    process.execPath,
    [rutaTsx(), path.join('scripts', 'pipeline', 'scrapear-medios.ts'), ...argumentosDesdeParametros(parametros)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PIPELINE_CORRIDA_ID: corrida.id,
        PIPELINE_ORIGEN: corrida.origen,
        PIPELINE_SNAPSHOT_MAX_CHARS: SNAPSHOT_MAX_CHARS,
        // El modo lo deciden los argumentos. Sin esto, un PIPELINE_DRY_RUN=true
        // olvidado en el .env convertía en prueba cada corrida del panel.
        PIPELINE_DRY_RUN: 'false',
        AGENT_BROWSER_SESSION: sesionBrowser,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Grupo propio en Linux/macOS para poder cortar todo el árbol al cancelar.
      detached: process.platform !== 'win32',
      windowsHide: true,
    }
  )
  corridaActual = { id: corrida.id, hijo, cancelada: false }

  let progreso: ProgresoCorrida | null = null
  let resumen: ResumenCorrida | null = null
  const pendientes: string[] = []
  const ultimasLineas: string[] = []
  let guardadas = 0

  const recibir = (linea: string, esError: boolean) => {
    const evento = parsearEvento(linea)
    if (evento?.tipo === 'progreso') { progreso = evento.progreso; return }
    if (evento?.tipo === 'resumen') { resumen = evento.resumen; return }
    const texto = esError ? `⚠ ${linea}` : linea
    console.log(`   [${corto}] ${texto}`)
    ultimasLineas.push(texto)
    if (ultimasLineas.length > 8) ultimasLineas.shift()
    if (guardadas < MAX_LINEAS_POR_CORRIDA) {
      pendientes.push(texto)
      guardadas++
      if (guardadas === MAX_LINEAS_POR_CORRIDA) pendientes.push('… (se alcanzó el tope de líneas guardadas para esta corrida)')
    }
  }
  createInterface({ input: hijo.stdout! }).on('line', l => recibir(l, false))
  createInterface({ input: hijo.stderr! }).on('line', l => recibir(l, true))

  const terminado = new Promise<number | null>(resolve => {
    hijo.on('error', error => {
      recibir(`No se pudo lanzar el pipeline: ${error.message}`, true)
      resolve(null)
    })
    hijo.on('close', codigo => resolve(codigo))
  })

  let ultimoLatidoAgente = Date.now()
  const volcar = async () => {
    const lote = pendientes.splice(0)
    try {
      await agregarLineas(prisma, corrida.id, lote)
      const { cancelar } = await latidoCorrida(prisma, corrida.id, progreso)
      if (cancelar && corridaActual && !corridaActual.cancelada) {
        corridaActual.cancelada = true
        log('🛑', `Cancelación pedida desde el panel: se corta la corrida ${corto}`)
        matar(hijo)
      }
      if (Date.now() - ultimoLatidoAgente > LATIDO_AGENTE_MS) {
        ultimoLatidoAgente = Date.now()
        await latidoAgente(prisma, NOMBRE, infoAgente())
      }
    } catch (error) {
      // Un corte de red no puede perder el log: el lote vuelve a la cola.
      pendientes.unshift(...lote)
      log('⚠️', `No se pudo actualizar la corrida en la base: ${String(error).slice(0, 120)}`)
    }
  }

  const temporizador = setInterval(() => { void volcar() }, FLUSH_MS)
  const codigo = await terminado
  clearInterval(temporizador)
  await volcar()

  // Por si el pipeline murió sin cerrar su navegador (cancelación, crash).
  ejecutarBrowser(comandos.cerrar(), {
    timeoutMs: 15_000,
    env: { ...process.env, AGENT_BROWSER_SESSION: sesionBrowser },
  })

  const cancelada = corridaActual?.cancelada ?? false
  const final = estadoFinal(codigo, cancelada, resumen)
  const error = final.error && final.estado === 'fallida' && !resumen
    ? `${final.error}. Últimas líneas: ${ultimasLineas.join(' | ')}`
    : final.error
  try {
    await finalizarCorrida(prisma, corrida.id, { estado: final.estado, resumen, progreso, error, exitCode: codigo })
  } catch (e) {
    log('⚠️', `No se pudo cerrar la corrida ${corto} en la base: ${String(e).slice(0, 120)}`)
  }
  corridaActual = null

  const r = resumen as ResumenCorrida | null
  const detalle = r
    ? `${r.hechosNuevos} hechos nuevos, ${r.coberturasVinculadas} coberturas, ${r.noticiasScrapeadas} noticias`
    : 'sin resumen'
  log(final.estado === 'completada' ? '✅' : '🚨', `Corrida ${corto} ${final.estado} (${detalle})${final.error ? ` — ${final.error}` : ''}`)
}

// ════════════════════════════════════════════
// BUCLE PRINCIPAL
// ════════════════════════════════════════════

async function main(): Promise<number> {
  log('🚀', `Agente "${NOMBRE}" iniciando (${os.platform()} ${os.arch()}, Node ${process.version})`)
  log('⚙️', PROGRAMADA_ACTIVA
    ? `Corrida diaria programada: ${HORA_PROGRAMADA} (hora argentina)`
    : 'Sin corrida diaria programada (PIPELINE_AGENTE_HORA)')
  log('⚙️', `Modelo: ${getConfigActiva().descripcion}`)

  try {
    await prisma.corridaPipeline.count()
  } catch (error) {
    log('❌', 'No se pudo leer la tabla corridas_pipeline. ¿Está DATABASE_URL en el .env y se aplicó la migración?')
    log('💡', 'Para aplicarla: npx prisma migrate deploy')
    log('  ', String(error).slice(0, 300))
    return 1
  }

  const huerfanas = await cerrarHuerfanas(prisma, NOMBRE)
  if (huerfanas > 0) log('🧹', `${huerfanas} corrida(s) que quedaron en curso de una sesión anterior se marcaron como fallidas`)

  let ultimaLimpieza = 0
  let erroresSeguidos = 0

  while (!deteniendo) {
    try {
      await latidoAgente(prisma, NOMBRE, infoAgente())
      await encolarProgramadaSiCorresponde()

      const corrida = await tomarSiguienteCorrida(prisma, NOMBRE)
      erroresSeguidos = 0
      if (corrida) {
        await ejecutarCorrida(corrida)
        continue // puede haber más en la cola
      }

      if (UNA_VEZ) break

      if (Date.now() - ultimaLimpieza > 24 * 60 * 60 * 1000) {
        const borradas = await limpiarLineasViejas(prisma)
        if (borradas > 0) log('🧹', `${borradas} líneas de log de más de 30 días borradas`)
        ultimaLimpieza = Date.now()
      }
    } catch (error) {
      erroresSeguidos++
      log('⚠️', `Error en el ciclo del agente (${erroresSeguidos}): ${String(error).slice(0, 200)}`)
      if (UNA_VEZ) return 1
      // Neon suspendido, wifi caído...: se reintenta sin inundar el log.
      await dormir(Math.min(5 * 60_000, INTERVALO_MS * erroresSeguidos))
      continue
    }
    await dormir(INTERVALO_MS)
  }
  return 0
}

async function detener(senal: string) {
  if (deteniendo) return
  deteniendo = true
  log('🛑', `${senal}: el agente se detiene`)
  despertar?.()
  if (corridaActual) {
    corridaActual.cancelada = true
    log('🛑', 'Se corta la corrida en curso')
    matar(corridaActual.hijo)
  }
  // Si en 30 s no terminó ordenadamente, se sale igual.
  setTimeout(() => process.exit(130), 30_000).unref()
}

process.on('SIGINT', () => { void detener('SIGINT') })
process.on('SIGTERM', () => { void detener('SIGTERM') })

main()
  .then(codigo => { process.exitCode = codigo })
  .catch(error => {
    log('❌', `Error fatal: ${String(error)}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
