/**
 * Probe de feeds RSS/sitemap para los medios del pipeline.
 *
 * POR QUÉ EXISTE
 * El plan de rediseño del pipeline (etapa 3) propone reemplazar
 * "browser + LLM para descubrir noticias" por "leer el feed estructurado del
 * medio" — 1-2s y costo cero contra 60-105s y ~12k tokens por medio. Pero esa
 * propuesta depende de una suposición sin verificar: qué cobertura real de
 * RSS/sitemap tienen los 120 medios configurados. Este contenedor de
 * desarrollo no tiene salida a los sitios de medios (el proxy devuelve 403),
 * así que la única forma de conseguir el dato es este script, corrido desde
 * GitHub Actions.
 *
 * Si la cobertura medida es alta, el rediseño sigue como está. Si es baja, el
 * camino de browser + LLM queda central y las etapas 4-5 del plan hay que
 * replantearlas. La tabla que produce este script ES el dato que decide eso —
 * no se supone, se mide.
 *
 * CASCADA (por medio, se queda con la primera que sirve)
 *   1. /sitemap-news.xml           — estándar de Google News
 *   2. /sitemap.xml, /news-sitemap.xml, /sitemap_index.xml — otros sitemaps comunes
 *   3. RSS en rutas típicas: /rss, /feed, /rss.xml, /feed.xml, /rss/,
 *      /arc/outboundfeeds/rss/ (este último es de la plataforma Arc)
 *   4. Autodiscovery: bajar la portada y buscar
 *      <link rel="alternate" type="application/rss+xml|atom+xml">
 *
 * LECCIÓN YA APRENDIDA (ver verificar-medios.ts)
 * Un 403 con headers de fetch pelados es el WAF de Cloudflare rechazando un
 * cliente que no parece un browser, NO "este medio no tiene feed". El
 * health-check anterior confundió eso y reportó ~30 medios como rotos que en
 * los logs del pipeline (que usa Chrome real) scrapean bien. Por eso este
 * script manda headers de browser real y clasifica 401/403/429/503 como
 * INCONCLUSO, nunca como "sin feed". 404 sí es determinante para una ruta
 * puntual: significa que ESA ruta no existe, así que la cascada sigue probando
 * las demás con normalidad.
 *
 * NO identifica al scraper como Usina de Justicia ni como bot — decisión
 * explícita del usuario. El User-Agent es el de un browser real.
 *
 * Uso:
 *   npx tsx scripts/pipeline/probar-feeds.ts
 *   npx tsx scripts/pipeline/probar-feeds.ts --solo-activos
 */

import { JSDOM } from 'jsdom'
import { MEDIOS, type MedioConfig } from './medios-config'
import { urlEfectiva, clasificarError, type Estado as EstadoError } from './verificar-medios'

const TIMEOUT_MS = 12_000
const CONCURRENCIA = 4

// Un feed cuyo ítem más reciente es más viejo que esto se marca "no fresco":
// los medios que scrapea el pipeline publican policiales todos los días, así
// que un feed sin nada nuevo en 45 días es un feed abandonado o mal
// encontrado (p. ej. un sitemap de páginas estáticas), no una fuente viable.
export const UMBRAL_DIAS_FRESCURA = 45

// Headers de un browser real. Sin esto la mayoría de los medios grandes
// rebota con 403 antes de que el fetch llegue a nada — ver verificar-medios.ts.
const HEADERS_BROWSER: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
}

/** Códigos que un WAF devuelve para rechazar un cliente que no es un browser. Inconcluyente, no "no existe". */
const CODIGOS_BLOQUEO = [401, 403, 429, 503]

export type EstadoFeed = 'ENCONTRADO' | 'INCONCLUSO' | 'SIN_FEED'

export type ResultadoIntento =
  | 'OK'
  | 'VACIO'
  | 'NO_XML'
  | 'BLOQUEADO'
  | 'HTTP_ERROR'
  | EstadoError // DNS_MUERTO | TLS_INVALIDO | TIMEOUT | ERROR | ...

export interface Intento {
  ruta: string
  url: string
  resultado: ResultadoIntento
  detalle: string
}

export interface ItemFeed {
  titulo: string | null
  url: string | null
  fecha: Date | null
}

export type TipoFeed = 'rss' | 'atom' | 'sitemap' | 'sitemap-index'

export interface FeedParseado {
  tipo: TipoFeed
  items: ItemFeed[]
}

export interface ResultadoFeed {
  id: string
  nombre: string
  provincia: string
  activo: boolean
  origen: string | null
  estrategia: string | null
  feedUrl: string | null
  items: number
  tieneFechas: boolean
  fresco: boolean | null
  fechaMasReciente: string | null
  estado: EstadoFeed
  motivo: string
  intentos: Intento[]
}

/** Deriva el dominio raíz del medio — el feed casi siempre vive ahí, no en la sección de policiales. */
export function origenDe(medio: MedioConfig): string | null {
  const url = urlEfectiva(medio)
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

async function fetchConTimeout(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; status: number; texto: string }> {
  const control = new AbortController()
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: control.signal,
      redirect: 'follow',
      headers: HEADERS_BROWSER,
    })
    const texto = res.ok ? await res.text() : ''
    return { ok: res.ok, status: res.status, texto }
  } finally {
    clearTimeout(reloj)
  }
}

function fechaDeTexto(texto: string | null | undefined): Date | null {
  if (!texto) return null
  const d = new Date(texto.trim())
  return Number.isNaN(d.getTime()) ? null : d
}

function textoDe(el: Element | null, selector: string): string | null {
  return el?.querySelector(selector)?.textContent?.trim() || null
}

/** RSS: <item><title/><link/><pubDate/></item>. dc:date como respaldo (algunos feeds no usan pubDate). */
function extraerItemRSS(el: Element): ItemFeed {
  const fecha =
    fechaDeTexto(textoDe(el, 'pubDate')) ??
    fechaDeTexto(el.getElementsByTagName('dc:date')[0]?.textContent ?? null)
  return { titulo: textoDe(el, 'title'), url: textoDe(el, 'link'), fecha }
}

/** Atom: <entry><title/><link href="…"/><updated/></entry>. El link va en un atributo, no en texto. */
function extraerEntradaAtom(el: Element): ItemFeed {
  const link = el.querySelector('link')
  const url = link?.getAttribute('href')?.trim() || link?.textContent?.trim() || null
  const fecha = fechaDeTexto(textoDe(el, 'updated')) ?? fechaDeTexto(textoDe(el, 'published'))
  return { titulo: textoDe(el, 'title'), url, fecha }
}

/** Sitemap (incluye sitemap-news): <url><loc/><lastmod/><news:publication_date/></url>. */
function extraerUrlSitemap(el: Element): ItemFeed {
  const fecha =
    fechaDeTexto(textoDe(el, 'lastmod')) ??
    fechaDeTexto(el.getElementsByTagName('news:publication_date')[0]?.textContent ?? null)
  return { titulo: textoDe(el, 'news:title') ?? textoDe(el, 'title'), url: textoDe(el, 'loc'), fecha }
}

/**
 * Parsea RSS, Atom o sitemap (y sitemapindex) desde el mismo texto XML.
 * Lanza si el XML está mal formado — quien llama lo captura y lo reporta como
 * NO_XML en vez de tumbar la corrida completa.
 */
export function parsearFeedXML(texto: string): FeedParseado {
  const dom = new JSDOM(texto, { contentType: 'text/xml' })
  const doc = dom.window.document

  const items = doc.querySelectorAll('item')
  if (items.length > 0) return { tipo: 'rss', items: [...items].map(extraerItemRSS) }

  const entradas = doc.querySelectorAll('entry')
  if (entradas.length > 0) return { tipo: 'atom', items: [...entradas].map(extraerEntradaAtom) }

  const urls = doc.querySelectorAll('url')
  if (urls.length > 0) return { tipo: 'sitemap', items: [...urls].map(extraerUrlSitemap) }

  // sitemapindex: lista de sub-sitemaps, no de artículos. Se reporta como
  // encontrado (tipo distinto) pero sin fechas — resolver los sub-sitemaps
  // queda para la Etapa 4, no es parte de este probe.
  const subSitemaps = doc.querySelectorAll('sitemap')
  if (subSitemaps.length > 0) {
    return {
      tipo: 'sitemap-index',
      items: [...subSitemaps].map(el => ({ titulo: null, url: textoDe(el, 'loc'), fecha: null })),
    }
  }

  return { tipo: 'rss', items: [] }
}

/** Busca <link rel="alternate" type="…rss|atom…"> en el HTML de portada. Case-insensitive en atributos, href puede ser relativo. */
export function extraerFeedsAutodiscovery(html: string, origen: string): string[] {
  const dom = new JSDOM(html)
  const candidatos = dom.window.document.querySelectorAll('link')
  const hrefs: string[] = []
  for (const link of candidatos) {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase()
    const tipo = (link.getAttribute('type') ?? '').toLowerCase()
    const href = link.getAttribute('href')
    if (rel !== 'alternate' || !href) continue
    if (!/rss\+xml|atom\+xml/.test(tipo)) continue
    try {
      hrefs.push(new URL(href, origen).toString())
    } catch {
      // href inválido — se ignora, no tumba el resto del autodiscovery
    }
  }
  return hrefs
}

async function probarUrl(
  url: string,
  fetchImpl: typeof fetch
): Promise<{ items: ItemFeed[] | null; intento: Omit<Intento, 'ruta'> }> {
  try {
    const res = await fetchConTimeout(url, fetchImpl)
    if (!res.ok) {
      const bloqueo = CODIGOS_BLOQUEO.includes(res.status)
      return {
        items: null,
        intento: {
          url,
          resultado: bloqueo ? 'BLOQUEADO' : 'HTTP_ERROR',
          detalle: bloqueo ? `HTTP ${res.status} — probable WAF, NO concluyente` : `HTTP ${res.status}`,
        },
      }
    }
    let parseado: FeedParseado
    try {
      parseado = parsearFeedXML(res.texto)
    } catch {
      return { items: null, intento: { url, resultado: 'NO_XML', detalle: 'no es XML válido' } }
    }
    if (parseado.items.length === 0) {
      return { items: null, intento: { url, resultado: 'VACIO', detalle: 'XML válido sin ítems' } }
    }
    return {
      items: parseado.items,
      intento: { url, resultado: 'OK', detalle: `${parseado.items.length} ítems (${parseado.tipo})` },
    }
  } catch (error) {
    const { estado, detalle } = clasificarError(error)
    return { items: null, intento: { url, resultado: estado, detalle } }
  }
}

/** Rutas de sitemap/RSS a probar, en el orden de la cascada. */
const RUTAS_CASCADA = [
  '/sitemap-news.xml',
  '/sitemap.xml',
  '/news-sitemap.xml',
  '/sitemap_index.xml',
  '/rss',
  '/feed',
  '/rss.xml',
  '/feed.xml',
  '/rss/',
  '/arc/outboundfeeds/rss/',
]

/** DNS muerto o TLS roto son del dominio entero, no de la ruta: no vale la pena seguir probando rutas. */
function esFalloDeDominio(resultado: ResultadoIntento): boolean {
  return resultado === 'DNS_MUERTO' || resultado === 'TLS_INVALIDO'
}

function calcularFrescura(
  items: ItemFeed[],
  ahora: Date = new Date()
): { tieneFechas: boolean; fresco: boolean | null; fechaMasReciente: string | null } {
  const fechas = items.map(i => i.fecha).filter((f): f is Date => f !== null)
  if (fechas.length === 0) return { tieneFechas: false, fresco: null, fechaMasReciente: null }
  const masReciente = new Date(Math.max(...fechas.map(f => f.getTime())))
  const diasDesde = (ahora.getTime() - masReciente.getTime()) / (1000 * 60 * 60 * 24)
  return { tieneFechas: true, fresco: diasDesde <= UMBRAL_DIAS_FRESCURA, fechaMasReciente: masReciente.toISOString() }
}

function motivoSinFeed(intentos: Intento[]): string {
  const falloDominio = intentos.find(i => esFalloDeDominio(i.resultado))
  if (falloDominio) return `${falloDominio.resultado}: ${falloDominio.detalle}`
  const timeout = intentos.find(i => i.resultado === 'TIMEOUT')
  if (timeout && intentos.every(i => i.resultado === 'TIMEOUT')) return `TIMEOUT: ${timeout.detalle}`
  return `ninguna de ${intentos.length} rutas probadas dio un feed usable`
}

export async function probarMedio(medio: MedioConfig, fetchImpl: typeof fetch = fetch): Promise<ResultadoFeed> {
  const base = {
    id: medio.id,
    nombre: medio.nombre,
    provincia: medio.provincia ?? (medio.tipo === 'nacional' ? 'Nacional' : '—'),
    activo: medio.activo !== false,
  }
  const origen = origenDe(medio)
  if (!origen) {
    return {
      ...base,
      origen: null,
      estrategia: null,
      feedUrl: null,
      items: 0,
      tieneFechas: false,
      fresco: null,
      fechaMasReciente: null,
      estado: 'SIN_FEED',
      motivo: 'no se pudo derivar el dominio (sin url ni urlPoliciales)',
      intentos: [],
    }
  }

  const intentos: Intento[] = []

  for (const ruta of RUTAS_CASCADA) {
    const url = new URL(ruta, origen).toString()
    const { items, intento } = await probarUrl(url, fetchImpl)
    intentos.push({ ruta, ...intento })
    if (items) {
      const frescura = calcularFrescura(items)
      return {
        ...base,
        origen,
        estrategia: ruta,
        feedUrl: url,
        items: items.length,
        ...frescura,
        estado: 'ENCONTRADO',
        motivo: `encontrado en ${ruta}`,
        intentos,
      }
    }
    if (esFalloDeDominio(intento.resultado)) break // el dominio entero está caído, no vale seguir
  }

  // Autodiscovery: solo tiene sentido si el dominio respondió antes (si no,
  // ya se cortó arriba por esFalloDeDominio, así que este fetch confirmaría lo mismo).
  const yaConfirmoDominioMuerto = intentos.some(i => esFalloDeDominio(i.resultado))
  if (!yaConfirmoDominioMuerto) {
    const { items, intento: intentoPortada } = await probarUrl(origen, fetchImpl)
    if (items) {
      // La portada misma resultó ser XML (caso raro, pero no imposible con
      // ciertos proxies) — igual se reporta como autodiscovery del origen.
      const frescura = calcularFrescura(items)
      intentos.push({ ruta: '(portada)', ...intentoPortada })
      return {
        ...base,
        origen,
        estrategia: 'autodiscovery',
        feedUrl: origen,
        items: items.length,
        ...frescura,
        estado: 'ENCONTRADO',
        motivo: 'encontrado por autodiscovery',
        intentos,
      }
    }
    intentos.push({ ruta: '(portada)', ...intentoPortada })

    // Si la portada cargó bien (aunque no fuera XML), buscar <link rel=alternate> ahí.
    if (intentoPortada.resultado === 'VACIO' || intentoPortada.resultado === 'NO_XML') {
      const html = await (async () => {
        // Necesitamos el HTML crudo, no el resultado del intento anterior
        // (que ya se descartó por no ser XML útil). Se vuelve a pedir el
        // origen una sola vez más — es aceptable: es 1 request extra por medio,
        // no por ruta.
        try {
          const res = await fetchConTimeout(origen, fetchImpl)
          return res.ok ? res.texto : ''
        } catch {
          return ''
        }
      })()
      const feeds = extraerFeedsAutodiscovery(html, origen)
      for (const feedUrl of feeds) {
        const { items: itemsFeed, intento } = await probarUrl(feedUrl, fetchImpl)
        intentos.push({ ruta: 'autodiscovery', ...intento })
        if (itemsFeed) {
          const frescura = calcularFrescura(itemsFeed)
          return {
            ...base,
            origen,
            estrategia: `autodiscovery:${feedUrl}`,
            feedUrl,
            items: itemsFeed.length,
            ...frescura,
            estado: 'ENCONTRADO',
            motivo: `encontrado por autodiscovery en ${feedUrl}`,
            intentos,
          }
        }
      }
    }
  }

  const hayBloqueo = intentos.some(i => i.resultado === 'BLOQUEADO')
  return {
    ...base,
    origen,
    estrategia: null,
    feedUrl: null,
    items: 0,
    tieneFechas: false,
    fresco: null,
    fechaMasReciente: null,
    estado: hayBloqueo ? 'INCONCLUSO' : 'SIN_FEED',
    motivo: hayBloqueo
      ? 'al menos un intento devolvió 401/403/429/503 — probable WAF, no concluyente'
      : motivoSinFeed(intentos),
    intentos,
  }
}

const PRIORIDAD: Record<EstadoFeed, number> = { SIN_FEED: 0, INCONCLUSO: 1, ENCONTRADO: 2 }

export function tablaMarkdown(resultados: ResultadoFeed[]): string {
  const encontrados = resultados
    .filter(r => r.estado === 'ENCONTRADO')
    .sort((a, b) => Number(b.activo) - Number(a.activo) || a.id.localeCompare(b.id))

  const filasEncontrados = encontrados.map(r => {
    const activo = r.activo ? 'sí' : 'no'
    const frescura = r.tieneFechas ? (r.fresco ? '🟢 fresco' : '🔴 viejo') : '⚪ sin fecha'
    return `| \`${r.id}\` | ${r.nombre} | ${activo} | ${r.estrategia} | ${r.feedUrl} | ${r.items} | ${frescura} |`
  })

  const inconclusos = resultados
    .filter(r => r.estado === 'INCONCLUSO')
    .sort((a, b) => a.id.localeCompare(b.id))
  const filasInconclusos = inconclusos.map(
    r => `| \`${r.id}\` | ${r.nombre} | ${r.activo ? 'sí' : 'no'} | ${r.motivo} |`
  )

  const sinFeed = resultados.filter(r => r.estado === 'SIN_FEED').sort((a, b) => a.id.localeCompare(b.id))
  const filasSinFeed = sinFeed.map(r => `| \`${r.id}\` | ${r.nombre} | ${r.activo ? 'sí' : 'no'} | ${r.motivo} |`)

  return [
    `### ✅ ${encontrados.length} medio(s) con feed usable`,
    '',
    '| id | medio | activo | estrategia | feed | ítems | frescura |',
    '|---|---|---|---|---|---|---|',
    ...filasEncontrados,
    '',
    `### ❓ ${inconclusos.length} medio(s) INCONCLUYENTE(S) — probable WAF, no leer como "sin feed"`,
    '',
    '| id | medio | activo | motivo |',
    '|---|---|---|---|',
    ...filasInconclusos,
    '',
    `### ⛔ ${sinFeed.length} medio(s) sin feed encontrado`,
    '',
    '| id | medio | activo | motivo |',
    '|---|---|---|---|',
    ...filasSinFeed,
  ].join('\n')
}

export function resumen(resultados: ResultadoFeed[]): string {
  const activos = resultados.filter(r => r.activo)
  const totalActivos = activos.length
  const totalTodos = resultados.length
  const encontradosActivos = activos.filter(r => r.estado === 'ENCONTRADO').length
  const encontradosTodos = resultados.filter(r => r.estado === 'ENCONTRADO').length
  const pct = (n: number, total: number) => (total === 0 ? '0' : ((n / total) * 100).toFixed(0))

  return [
    '## Cobertura de feeds — el número que decide el plan',
    '',
    `- **Sobre los ${totalActivos} medios activos**: ${encontradosActivos}/${totalActivos} ` +
      `(${pct(encontradosActivos, totalActivos)}%) tienen un feed usable.`,
    `- **Sobre los ${totalTodos} medios totales**: ${encontradosTodos}/${totalTodos} ` +
      `(${pct(encontradosTodos, totalTodos)}%) tienen un feed usable.`,
    `- Inconcluyentes (probable WAF, no cuentan ni a favor ni en contra): ${resultados.filter(r => r.estado === 'INCONCLUSO').length}.`,
    '',
    'Si la cobertura de activos supera el 70%, el diseño de descubrimiento por ' +
      'feed (Etapa 4 del plan) sigue como está. Si queda muy por debajo, el ' +
      'camino de browser + LLM sigue siendo necesario como estrategia central y ' +
      'las etapas 4-5 hay que replantearlas.',
  ].join('\n')
}

async function main(): Promise<void> {
  const soloActivos = process.argv.includes('--solo-activos')
  const aProbar = soloActivos ? MEDIOS.filter(m => m.activo !== false) : MEDIOS

  console.error(`Probando feeds de ${aProbar.length} medios…`)

  const resultados: ResultadoFeed[] = []
  for (let i = 0; i < aProbar.length; i += CONCURRENCIA) {
    const tanda = aProbar.slice(i, i + CONCURRENCIA)
    resultados.push(...(await Promise.all(tanda.map(m => probarMedio(m)))))
    console.error(`  ${Math.min(i + CONCURRENCIA, aProbar.length)}/${aProbar.length}`)
  }

  console.log('## Probe de feeds RSS/sitemap\n')
  console.log(resumen(resultados))
  console.log('\n### Detalle\n')
  console.log(tablaMarkdown(resultados))
}

const invocado = process.argv[1] ?? ''
if (invocado.endsWith('probar-feeds.ts') || invocado.endsWith('probar-feeds.js')) {
  main()
}
