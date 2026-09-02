/**
 * Auditoría de la CSP en Report-Only contra un sitio real.
 *
 * POR QUÉ EXISTE
 * `src/config/csp.mjs` mantiene 7 directivas en `Content-Security-Policy-Report-Only`
 * porque pasarlas a bloqueo sin datos reales puede dejar el mapa en blanco (Google
 * Maps y jsDelivr cambian de dominio sin aviso). El endpoint `/api/csp-report` iba a
 * ser esa fuente de datos, pero sus logs se pierden a la hora en el plan Hobby de
 * Vercel. Este script hace lo que `csp.mjs` describe como paso manual: recorrer el
 * sitio con un browser real y juntar cada "Refused to ..." de la consola.
 *
 * NO TOCA NADA: abre páginas, hace clicks y lee. No escribe a la base, no manda
 * bearer tokens reales, no cambia `csp.mjs`. Ver Fase F del plan para qué se hace
 * con el resultado.
 *
 * Cada paso del recorrido es "best effort": si un selector no existe (cambió un
 * componente, la página no cargó a tiempo) se registra y se sigue — el objetivo es
 * la tabla de violaciones, no que el script sea un test end-to-end estricto.
 */

import { _DIRECTIVAS_OBSERVADAS } from '../../src/config/csp.mjs'

// ────────────────────────────────────────────────────────────────────────────
// Parseo de mensajes de consola
// ────────────────────────────────────────────────────────────────────────────

export interface Violacion {
  directiva: string
  uri: string
}

const RE_REFUSED = /Refused to/i
const RE_ES_CSP = /Content Security Policy/i
const RE_DIRECTIVA = /Content Security Policy directive:\s*"([a-z-]+)/i
// Captura la URI entre "Refused to ..." y el primer "because". Si no hay
// comillas ahí (scripts/estilos inline), el grupo queda undefined.
const RE_URI = /Refused to (?:[^']*?)(?:'([^']+)')?\s+because/i

/**
 * Parsea un mensaje de consola de Chrome y devuelve la directiva violada y la
 * URI bloqueada, o null si el mensaje no es una violación de CSP.
 *
 * Tolera los formatos que emite Chrome:
 *   - bloqueo real:    Refused to load the script 'https://x' because ... directive: "script-src 'self'".
 *   - Report-Only:     [Report Only] Refused to connect to 'https://y' because ... directive: "connect-src 'self'".
 *   - inline (sin URI): [Report Only] Refused to apply inline style because ... directive: "style-src 'self'".
 */
export function parsearMensajeConsola(texto: string): Violacion | null {
  if (!RE_REFUSED.test(texto) || !RE_ES_CSP.test(texto)) return null

  const mDirectiva = texto.match(RE_DIRECTIVA)
  if (!mDirectiva) return null

  const mUri = texto.match(RE_URI)
  const uri = mUri?.[1] || (/eval/i.test(texto) ? 'eval (unsafe-eval)' : 'inline')

  return { directiva: mDirectiva[1], uri }
}

// ────────────────────────────────────────────────────────────────────────────
// Deduplicación y agregación
// ────────────────────────────────────────────────────────────────────────────

export interface ViolacionAgregada {
  directiva: string
  uri: string
  paginas: string[]
  veces: number
}

export class RegistradorViolaciones {
  private mapa = new Map<string, { directiva: string; uri: string; paginas: Set<string>; veces: number }>()

  registrar(v: Violacion, pagina: string): void {
    const clave = `${v.directiva} ${v.uri}`
    let entrada = this.mapa.get(clave)
    if (!entrada) {
      entrada = { directiva: v.directiva, uri: v.uri, paginas: new Set(), veces: 0 }
      this.mapa.set(clave, entrada)
    }
    entrada.paginas.add(pagina)
    entrada.veces++
  }

  lista(): ViolacionAgregada[] {
    return [...this.mapa.values()]
      .map(e => ({ directiva: e.directiva, uri: e.uri, paginas: [...e.paginas].sort(), veces: e.veces }))
      .sort((a, b) => a.directiva.localeCompare(b.directiva) || a.uri.localeCompare(b.uri))
  }
}

/** Directivas de CSP_OBSERVADA que no aparecen en ninguna violación registrada. */
export function directivasSinViolaciones(violaciones: ViolacionAgregada[]): string[] {
  const conViolacion = new Set(violaciones.map(v => v.directiva))
  return Object.keys(_DIRECTIVAS_OBSERVADAS as Record<string, unknown>).filter(d => !conViolacion.has(d))
}

// ────────────────────────────────────────────────────────────────────────────
// Detección de redirect a login de Vercel (la duda del SSO)
// ────────────────────────────────────────────────────────────────────────────

const RE_LOGIN_VERCEL = /vercel\.com\/login|vercel\.com\/sso|\/sso-api\b/i

export function esRedirectALoginVercel(url: string): boolean {
  return RE_LOGIN_VERCEL.test(url)
}

// ────────────────────────────────────────────────────────────────────────────
// Recorrido del sitio (best effort)
// ────────────────────────────────────────────────────────────────────────────

export interface PasoResultado {
  paso: string
  ok: boolean
  detalle?: string
}

/**
 * Subconjunto de la API de Playwright `Page` que usa el recorrido. Se declara
 * acá (en vez de importar el tipo real) para que los tests puedan inyectar un
 * objeto plano sin depender de Playwright.
 */
export interface PaginaLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>
  url(): string
  waitForTimeout(ms: number): Promise<void>
  getByText(texto: string, opts?: { exact?: boolean }): { click(opts?: Record<string, unknown>): Promise<void> }
  mouse: { wheel(dx: number, dy: number): Promise<void> }
  keyboard: { press(key: string): Promise<void> }
  evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>
}

/** Envuelve un paso del recorrido: nunca tumba la corrida, solo lo registra. */
async function intentar(pasos: PasoResultado[], paso: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pasos.push({ paso, ok: true })
  } catch (err) {
    pasos.push({ paso, ok: false, detalle: err instanceof Error ? err.message.slice(0, 200) : String(err) })
  }
}

export interface ResultadoAuditoria {
  status: number
  redirigioALogin: boolean
  urlFinal: string
  pasos: PasoResultado[]
  adminUrlFinal: string | null
  cspReportStatus: number | null
}

/**
 * Recorre el sitio y ejerce las superficies que dependen de dominios de
 * terceros (Maps, jsDelivr) para maximizar la chance de disparar violaciones
 * reales de la CSP en Report-Only. El llamador es responsable de tener ya
 * enganchado `page.on('console', ...)` / `page.on('pageerror', ...)` antes de
 * invocar esto — el recorrido no sabe nada de cómo se registran violaciones.
 */
export async function recorrerSitio(page: PaginaLike, baseUrl: string): Promise<ResultadoAuditoria> {
  const pasos: PasoResultado[] = []
  const base = baseUrl.replace(/\/$/, '')

  // 1. GET a la URL base — status y redirect a login son la alarma real.
  let status = 0
  let urlFinal = base
  await intentar(pasos, `GET ${base}`, async () => {
    const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    status = resp?.status() ?? 0
    urlFinal = page.url()
  })
  const redirigioALogin = esRedirectALoginVercel(urlFinal)

  // Si ya nos mandó a un login, no tiene sentido seguir recorriendo: no hay
  // nada del sitio real que ver.
  if (redirigioALogin) {
    return { status, redirigioALogin, urlFinal, pasos, adminUrlFinal: null, cspReportStatus: null }
  }

  // 2. Home, /mapa-del-delito, /metodologia
  await intentar(pasos, 'GET /', () => page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => undefined))

  await intentar(pasos, 'GET /mapa-del-delito', () =>
    page.goto(base + '/mapa-del-delito', { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => undefined)
  )

  // Dar tiempo a que cargue Google Maps + DuckDB (el mapa hace fetch de
  // Parquet y arma el worker de WASM de forma asincrónica).
  await intentar(pasos, 'esperar carga del mapa', () => page.waitForTimeout(5_000))

  // Toggle a SAT — texto exacto del botón en SelectorFuente.tsx.
  await intentar(pasos, 'click en SAT', () => page.getByText('SAT', { exact: true }).click())
  await intentar(pasos, 'esperar filtros SAT', () => page.waitForTimeout(1_500))

  // Aplicar un filtro SAT — chip "Sexo" en FiltrosSAT.tsx.
  await intentar(pasos, 'abrir filtro Sexo', () => page.getByText('Sexo', { exact: true }).click())
  await intentar(pasos, 'esperar opciones del filtro', () => page.waitForTimeout(500))

  // Volver a SNIC.
  await intentar(pasos, 'click en SNIC', () => page.getByText('SNIC', { exact: true }).click())
  await intentar(pasos, 'esperar recarga SNIC', () => page.waitForTimeout(1_500))

  // Zoom con la rueda: los departamentos (CapaDepartamentos) recién cargan en
  // zoom >= 6, y ese fetch adicional de GeoJSON es otra superficie donde
  // podría faltar un dominio en connect-src.
  await intentar(pasos, 'zoom con rueda', async () => {
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -200)
    }
  })
  await intentar(pasos, 'esperar carga de departamentos', () => page.waitForTimeout(2_000))

  await intentar(pasos, 'GET /metodologia', () =>
    page.goto(base + '/metodologia', { waitUntil: 'domcontentloaded', timeout: 30_000 }).then(() => undefined)
  )

  // 4. /admin sin sesión → tiene que terminar en /admin/login.
  let adminUrlFinal: string | null = null
  await intentar(pasos, 'GET /admin sin sesión', async () => {
    await page.goto(base + '/admin', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    adminUrlFinal = page.url()
  })

  // 5. /api/csp-report con un cuerpo mínimo → debería responder 204.
  let cspReportStatus: number | null = null
  await intentar(pasos, 'POST /api/csp-report', async () => {
    const resultado = await page.evaluate(async (...args: unknown[]) => {
      const url = args[0] as string
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/csp-report' },
        body: JSON.stringify({ 'csp-report': { 'document-uri': 'auditoria', 'violated-directive': 'test' } }),
      })
      return r.status
    }, base + '/api/csp-report')
    cspReportStatus = resultado as number
  })

  return { status, redirigioALogin, urlFinal, pasos, adminUrlFinal, cspReportStatus }
}

// ────────────────────────────────────────────────────────────────────────────
// Reporte
// ────────────────────────────────────────────────────────────────────────────

export function tablaViolaciones(violaciones: ViolacionAgregada[]): string {
  if (violaciones.length === 0) {
    return '_Ninguna violación de CSP detectada durante el recorrido._'
  }
  const filas = violaciones.map(
    v => `| ${v.directiva} | \`${v.uri}\` | ${v.paginas.join(', ')} | ${v.veces} |`
  )
  return ['| Directiva | URI bloqueada | Páginas | Veces |', '|---|---|---|---|', ...filas].join('\n')
}

export function generarReporte(resultado: ResultadoAuditoria, violaciones: ViolacionAgregada[], urlBase: string): string {
  const lineas: string[] = []

  lineas.push('# Auditoría de CSP')
  lineas.push('')
  lineas.push(`URL auditada: \`${urlBase}\``)
  lineas.push('')

  if (resultado.status !== 200 || resultado.redirigioALogin) {
    lineas.push('## 🚨 Estado HTTP de producción')
    lineas.push('')
    if (resultado.redirigioALogin) {
      lineas.push(
        `🚨 La URL base redirigió a un login de Vercel (\`${resultado.urlFinal}\`). ` +
          'Esto sugiere que la protección SSO del proyecto está bloqueando a visitantes reales, ' +
          'no solo a este script — hay que verificarlo en Vercel → Settings → Deployment Protection.'
      )
    } else {
      lineas.push(`🚨 La URL base respondió con status ${resultado.status} en vez de 200.`)
    }
  } else {
    lineas.push('## ✅ Estado HTTP de producción')
    lineas.push('')
    lineas.push(`200 sin redirect a login (\`${resultado.urlFinal}\`).`)
  }
  lineas.push('')

  lineas.push('## Violaciones de CSP detectadas (Report-Only)')
  lineas.push('')
  lineas.push(tablaViolaciones(violaciones))
  lineas.push('')

  lineas.push('## Directivas en Report-Only sin ninguna violación')
  lineas.push('')
  lineas.push(
    '_Estas son candidatas a pasar a bloqueo en la Fase F — pero recién después de ' +
      'dos o tres corridas en días distintos sin que aparezca ninguna violación._'
  )
  lineas.push('')
  const limpias = directivasSinViolaciones(violaciones)
  if (limpias.length === 0) {
    lineas.push('_Ninguna — todas las directivas observadas tuvieron al menos una violación en esta corrida._')
  } else {
    for (const d of limpias) lineas.push(`- \`${d}\``)
  }
  lineas.push('')

  lineas.push('## Detalle del recorrido')
  lineas.push('')
  lineas.push('| Paso | Resultado | Detalle |')
  lineas.push('|---|---|---|')
  for (const p of resultado.pasos) {
    lineas.push(`| ${p.paso} | ${p.ok ? '✅' : '⚠️ (best effort, no bloqueante)'} | ${p.detalle ?? ''} |`)
  }
  lineas.push('')

  if (resultado.adminUrlFinal !== null) {
    const terminoEnLogin = /\/admin\/login/.test(resultado.adminUrlFinal)
    lineas.push('## /admin sin sesión')
    lineas.push('')
    lineas.push(
      terminoEnLogin
        ? `✅ Redirigió a login (\`${resultado.adminUrlFinal}\`).`
        : `🚨 No redirigió a /admin/login — terminó en \`${resultado.adminUrlFinal}\`.`
    )
    lineas.push('')
  }

  if (resultado.cspReportStatus !== null) {
    lineas.push('## POST /api/csp-report')
    lineas.push('')
    lineas.push(
      resultado.cspReportStatus === 204
        ? '✅ Respondió 204.'
        : `⚠️ Respondió ${resultado.cspReportStatus} (se esperaba 204).`
    )
    lineas.push('')
  }

  return lineas.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point — solo corre cuando se invoca el script directamente, nunca al
// importar sus funciones desde los tests.
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.argv.find(a => a.startsWith('--url='))?.slice('--url='.length)
    ?? process.env.CSP_AUDIT_URL
    ?? 'https://mapa-delito-usina.vercel.app'

  // Import dinámico: así los tests pueden importar el resto del módulo sin
  // que Node intente resolver `playwright` (no hace falta para los tests,
  // que inyectan su propia página falsa).
  const { chromium } = await import('playwright')

  console.error(`🔎 Auditando CSP contra ${url}...`)

  const browser = await chromium.launch()
  const violaciones = new RegistradorViolaciones()
  let paginaActual = url

  try {
    const page = await browser.newPage()

    page.on('console', msg => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return
      const v = parsearMensajeConsola(msg.text())
      if (v) violaciones.registrar(v, paginaActual)
    })
    page.on('pageerror', err => {
      const v = parsearMensajeConsola(err.message)
      if (v) violaciones.registrar(v, paginaActual)
    })

    // paginaActual se actualiza en cada goto para que el registrador de
    // consola sepa en qué página ocurrió cada violación. recorrerSitio no
    // expone eso, así que lo aproximamos con page.url() después de cada paso
    // relevante consultando la página real.
    const resultado = await recorrerSitio(
      new Proxy(page, {
        get(target, prop, receiver) {
          const valor = Reflect.get(target, prop, receiver)
          if (prop === 'goto' && typeof valor === 'function') {
            return async (...args: unknown[]) => {
              const r = await (valor as (...a: unknown[]) => Promise<unknown>).apply(target, args)
              paginaActual = target.url()
              return r
            }
          }
          return typeof valor === 'function' ? valor.bind(target) : valor
        },
      }) as unknown as PaginaLike,
      url
    )

    const lista = violaciones.lista()
    const reporte = generarReporte(resultado, lista, url)
    console.log(reporte)

    if (resultado.status !== 200 || resultado.redirigioALogin) {
      process.exitCode = 1
    }
  } finally {
    await browser.close()
  }
}

// Node ESM: comparar contra el argv real, no `require.main` (no existe acá).
const esEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (esEntryPoint) {
  main().catch(err => {
    console.error('❌ auditar-csp falló:', err)
    process.exitCode = 1
  })
}
