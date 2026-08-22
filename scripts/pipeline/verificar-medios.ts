/**
 * Health-check de los medios que scrapea el pipeline.
 *
 * POR QUÉ
 * Hay 74 medios configurados y no había forma de saber cuáles siguen vivos. El
 * log del pipeline del 19/8 ya delataba varios: `jornada` y `lamanana` con
 * ERR_NAME_NOT_RESOLVED (dominios muertos), `cadenaargentina` con el
 * certificado inválido, `tiemposanjuan` y `ellitoralcorrientes` con timeout.
 * Cada uno de esos gasta tiempo de la corrida diaria para nada.
 *
 * Y hay 9 medios de Buenos Aires esperando justamente esto: se agregaron con
 * `activo: false` porque no se pudo verificar que carguen ni que no tengan
 * paywall (el entorno donde se investigaron no tiene salida a internet).
 *
 * QUÉ VERIFICA Y QUÉ NO
 * Usa fetch, no un browser: alcanza para distinguir dominio muerto, TLS roto,
 * 404, timeout, redirect a otro dominio, y una estimación de si la página trae
 * enlaces. NO reemplaza al pipeline —que navega con Chrome y ejecuta JS—, así
 * que un sitio que renderiza todo del lado del cliente puede dar "carga pero
 * sin enlaces" y aun así funcionar. Eso se marca aparte, no como error.
 *
 * Tampoco detecta paywall de forma confiable: eso necesita leer una nota real.
 * Lo que sí hace es marcar los indicios (muro de suscripción en el HTML).
 *
 * Uso:
 *   npx tsx scripts/pipeline/verificar-medios.ts
 *   npx tsx scripts/pipeline/verificar-medios.ts --solo-activos
 *
 * Corre en GitHub Actions (.github/workflows/verificar-medios.yml) porque este
 * contenedor de desarrollo no tiene salida a internet.
 */

import { MEDIOS, type MedioConfig } from './medios-config'

const TIMEOUT_MS = 20_000

/** Indicios de muro de pago en el HTML. No es concluyente, solo una señal. */
const SENALES_PAYWALL = [
  'suscribite',
  'suscripción digital',
  'contenido exclusivo para suscriptores',
  'paywall',
  'registrate para seguir leyendo',
]

export type Estado =
  | 'OK'
  | 'SIN_ENLACES'
  | 'BLOQUEADO'
  | 'HTTP_ERROR'
  | 'DNS_MUERTO'
  | 'TLS_INVALIDO'
  | 'TIMEOUT'
  | 'REDIRECT_EXTERNO'
  | 'SIN_URL'
  | 'ERROR'

export interface Resultado {
  id: string
  nombre: string
  provincia: string
  url: string
  activo: boolean
  estado: Estado
  detalle: string
  enlaces: number
  indicioPaywall: boolean
}

/** La URL que el pipeline visita de verdad: urlPoliciales gana, url es el legado. */
export function urlEfectiva(medio: MedioConfig): string {
  return medio.urlPoliciales || medio.url || ''
}

/**
 * Clasifica el error de red en algo accionable.
 *
 * Los mensajes de undici no son estables entre versiones, así que se mira el
 * `cause.code` cuando está, y se cae al texto solo como respaldo.
 */
export function clasificarError(error: unknown): { estado: Estado; detalle: string } {
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  const code = err?.cause?.code ?? ''
  const texto = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`.toLowerCase()

  if (err?.name === 'AbortError' || texto.includes('timeout')) {
    return { estado: 'TIMEOUT', detalle: `no respondió en ${TIMEOUT_MS / 1000}s` }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || texto.includes('getaddrinfo')) {
    return { estado: 'DNS_MUERTO', detalle: 'el dominio no resuelve' }
  }
  if (code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' ||
      code === 'ERR_SSL_WRONG_VERSION_NUMBER' || texto.includes('certificate') ||
      texto.includes('altname')) {
    return { estado: 'TLS_INVALIDO', detalle: `certificado inválido (${code || 'ver detalle'})` }
  }
  if (code === 'ECONNREFUSED') return { estado: 'ERROR', detalle: 'conexión rechazada' }
  if (code === 'ECONNRESET') return { estado: 'ERROR', detalle: 'conexión cortada' }
  return { estado: 'ERROR', detalle: (err?.message ?? String(error)).slice(0, 80) }
}

/** Cuenta enlaces <a href> en el HTML. Grosero a propósito: solo interesa el orden de magnitud. */
export function contarEnlaces(html: string): number {
  return (html.match(/<a\s[^>]*href=/gi) ?? []).length
}

export function detectarIndicioPaywall(html: string): boolean {
  const bajo = html.toLowerCase()
  return SENALES_PAYWALL.some(s => bajo.includes(s))
}

export async function verificarMedio(
  medio: MedioConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Resultado> {
  const url = urlEfectiva(medio)
  const base: Omit<Resultado, 'estado' | 'detalle' | 'enlaces' | 'indicioPaywall'> = {
    id: medio.id,
    nombre: medio.nombre,
    provincia: medio.provincia ?? (medio.tipo === 'nacional' ? 'Nacional' : '—'),
    url,
    activo: medio.activo !== false,
  }

  if (!url) {
    return { ...base, estado: 'SIN_URL', detalle: 'no tiene url ni urlPoliciales', enlaces: 0, indicioPaywall: false }
  }

  const control = new AbortController()
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: control.signal,
      redirect: 'follow',
      headers: {
        // Sin User-Agent varios medios responden 403. No se busca evadir nada:
        // el pipeline navega con Chrome real, así que esto solo aproxima lo que
        // el pipeline ya ve.
        'User-Agent': 'Mozilla/5.0 (compatible; UsinaDeJusticia-healthcheck/1.0)',
        'Accept': 'text/html',
      },
    })

    if (!res.ok) {
      // 403/401/429 NO son "el medio está caído": son un WAF rechazando un
      // cliente que no parece un browser. La primera corrida de este script dio
      // 403/404 en ~30 medios, y varios de esos —rosario3, infocielo, lavoz,
      // eltribuno, norte— aparecen scrapeando bien en los logs del pipeline, que
      // usa Chrome real. Reportarlos como fallo llevaba a desactivar medios que
      // funcionan, que es peor que no tener el reporte.
      //
      // 404 también entra acá: puede ser que la sección exista solo para
      // clientes con JS, o que el WAF devuelva 404 en vez de 403 para no
      // confirmar la existencia del recurso.
      const bloqueo = [401, 403, 404, 429, 503].includes(res.status)
      return {
        ...base,
        estado: bloqueo ? 'BLOQUEADO' : 'HTTP_ERROR',
        detalle: bloqueo
          ? `HTTP ${res.status} — probable WAF, NO concluyente: verificar con browser`
          : `HTTP ${res.status}`,
        enlaces: 0,
        indicioPaywall: false,
      }
    }

    const destino = new URL(res.url)
    const origen = new URL(url)
    // Compara el dominio registrable de forma aproximada (últimos 2-3 labels):
    // un redirect de www.medio.com.ar a medio.com.ar es normal, uno a otro sitio no.
    const raiz = (h: string) => h.split('.').slice(-3).join('.')
    if (raiz(destino.hostname) !== raiz(origen.hostname)) {
      return {
        ...base,
        estado: 'REDIRECT_EXTERNO',
        detalle: `redirige a ${destino.hostname}`,
        enlaces: 0,
        indicioPaywall: false,
      }
    }

    const html = await res.text()
    const enlaces = contarEnlaces(html)
    const indicioPaywall = detectarIndicioPaywall(html)

    // Umbral bajo a propósito: una sección de policiales real tiene decenas de
    // enlaces. Menos de 5 casi siempre es una página que renderiza con JS, y eso
    // no es un error — el pipeline usa Chrome y sí la ve.
    if (enlaces < 5) {
      return { ...base, estado: 'SIN_ENLACES', detalle: `${enlaces} enlaces (¿render por JS?)`, enlaces, indicioPaywall }
    }

    return { ...base, estado: 'OK', detalle: `${enlaces} enlaces`, enlaces, indicioPaywall }
  } catch (error) {
    const { estado, detalle } = clasificarError(error)
    return { ...base, estado, detalle, enlaces: 0, indicioPaywall: false }
  } finally {
    clearTimeout(reloj)
  }
}

/** Orden de la tabla: primero lo que hay que mirar. */
const PRIORIDAD: Record<Estado, number> = {
  DNS_MUERTO: 0, TLS_INVALIDO: 1, HTTP_ERROR: 2, TIMEOUT: 3, REDIRECT_EXTERNO: 4,
  SIN_URL: 5, ERROR: 6, BLOQUEADO: 7, SIN_ENLACES: 8, OK: 9,
}

export function tablaMarkdown(resultados: Resultado[]): string {
  const ordenados = [...resultados].sort(
    (a, b) => PRIORIDAD[a.estado] - PRIORIDAD[b.estado] || a.id.localeCompare(b.id)
  )
  const filas = ordenados.map(r => {
    const activo = r.activo ? 'sí' : 'no'
    const pw = r.indicioPaywall ? ' ⚠️ paywall?' : ''
    return `| \`${r.id}\` | ${r.nombre} | ${r.provincia} | ${activo} | **${r.estado}** | ${r.detalle}${pw} |`
  })
  return [
    '| id | medio | provincia | activo | estado | detalle |',
    '|---|---|---|---|---|---|',
    ...filas,
  ].join('\n')
}

export function resumen(resultados: Resultado[]): string {
  const porEstado = new Map<Estado, number>()
  for (const r of resultados) porEstado.set(r.estado, (porEstado.get(r.estado) ?? 0) + 1)

  // Solo lo INEQUÍVOCO cuenta como roto: DNS que no resuelve, TLS inválido,
  // timeout, redirect a otro dominio, sin URL. BLOQUEADO y SIN_ENLACES quedan
  // afuera a propósito — los dos significan "este chequeo no puede decidir",
  // no "el medio no sirve".
  const roto = resultados.filter(
    r => r.activo && !['OK', 'SIN_ENLACES', 'BLOQUEADO'].includes(r.estado)
  )
  const inconcluyentes = resultados.filter(
    r => r.activo && ['BLOQUEADO', 'SIN_ENLACES'].includes(r.estado)
  )
  const listosParaActivar = resultados.filter(r => !r.activo && r.estado === 'OK')

  const lineas = [
    `Verificados **${resultados.length}** medios.`,
    '',
    ...[...porEstado.entries()]
      .sort((a, b) => PRIORIDAD[a[0]] - PRIORIDAD[b[0]])
      .map(([e, n]) => `- ${e}: ${n}`),
  ]

  if (roto.length > 0) {
    lineas.push(
      '',
      `### ⚠️ ${roto.length} medio(s) ACTIVO(S) con problemas`,
      'Cada uno gasta tiempo de la corrida diaria para nada. Candidatos a desactivar:',
      '',
      ...roto.map(r => `- \`${r.id}\` (${r.nombre}) — ${r.estado}: ${r.detalle}`)
    )
  }
  if (inconcluyentes.length > 0) {
    lineas.push(
      '',
      `### ❓ ${inconcluyentes.length} medio(s) activo(s) sin veredicto`,
      'NO desactivar por esto. Un 403 casi siempre es el WAF rechazando un fetch ' +
        'sin browser, y el pipeline usa Chrome real: varios de estos scrapean bien. ' +
        'Si alguno se quiere revisar, abrirlo a mano.',
      '',
      ...inconcluyentes.map(r => `- \`${r.id}\` (${r.nombre}) — ${r.estado}: ${r.detalle}`)
    )
  }
  if (listosParaActivar.length > 0) {
    lineas.push(
      '',
      `### ✅ ${listosParaActivar.length} medio(s) inactivo(s) que responden bien`,
      'Candidatos a activar. Antes de hacerlo, abrir 2-3 notas para confirmar que no haya paywall:',
      '',
      ...listosParaActivar.map(r => `- \`${r.id}\` (${r.nombre})${r.indicioPaywall ? ' ⚠️ posible paywall' : ''}`)
    )
  }
  return lineas.join('\n')
}

async function main(): Promise<void> {
  const soloActivos = process.argv.includes('--solo-activos')
  const aVerificar = soloActivos ? MEDIOS.filter(m => m.activo !== false) : MEDIOS

  console.error(`Verificando ${aVerificar.length} medios…`)

  // Tandas de 6: suficiente para que no tarde una eternidad, sin parecer un
  // escaneo agresivo contra sitios de terceros.
  const resultados: Resultado[] = []
  for (let i = 0; i < aVerificar.length; i += 6) {
    const tanda = aVerificar.slice(i, i + 6)
    resultados.push(...await Promise.all(tanda.map(m => verificarMedio(m))))
    console.error(`  ${Math.min(i + 6, aVerificar.length)}/${aVerificar.length}`)
  }

  console.log('## Health-check de medios\n')
  console.log(resumen(resultados))
  console.log('\n### Detalle\n')
  console.log(tablaMarkdown(resultados))
}

const invocado = process.argv[1] ?? ''
if (invocado.endsWith('verificar-medios.ts') || invocado.endsWith('verificar-medios.js')) {
  main()
}
