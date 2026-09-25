/**
 * Pipeline de scraping de medios periodísticos.
 *
 * Flujo completo:
 * 0. Verifica que el proveedor LLM acepte requests (si no, sale con error en
 *    segundos en lugar de gastar la corrida entera)
 * 1. agent-browser (CLI) navega secciones policiales de cada medio
 * 2. El LLM identifica los links de homicidios en el snapshot de la portada
 * 3. Se visita cada link y se extrae el texto de la nota
 * 4. El LLM extrae datos estructurados (openrouter.ts)
 * 5. Deduplicador determina si es hecho nuevo o cobertura existente
 * 6. API Georef normaliza ubicaciones
 * 7. Se inserta en Neon con confianza PRELIMINAR
 *
 * Uso:
 *   npx tsx scripts/pipeline/scrapear-medios.ts
 *   npx tsx scripts/pipeline/scrapear-medios.ts --dry-run
 *   npx tsx scripts/pipeline/scrapear-medios.ts --medio=infobae
 *   npx tsx scripts/pipeline/scrapear-medios.ts --provincias="Santa Fe,Chaco" --incluir-nacionales \
 *       --foco="Rosario,Villa Gobernador Gálvez" --max-noticias=15
 *
 * Opciones de alcance: ver src/lib/pipeline/opciones-corrida.ts. Las corridas
 * que encola el panel /admin/pipeline las lanza el agente local
 * (scripts/pipeline/agente-local.ts) con estos mismos argumentos.
 *
 * Código de salida: 0 si la corrida es confiable (aunque no haya encontrado
 * nada), 1 si no lo es — proveedor LLM caído, corrida abortada, browser roto.
 * Antes salía siempre con 0, y del 7 al 24/9/2026 el workflow quedó en verde
 * 18 días seguidos sin una sola llamada exitosa al LLM.
 */

import './cargar-env'
import { prisma } from '../../src/lib/mapa/queries'
import { extraerDatosNoticia } from '../../src/lib/mapa/openrouter'
import { deduplicar, clasificarCobertura, urlYaRegistrada } from '../../src/lib/mapa/deduplicador'
import {
  crearClienteLLM,
  parametrosExtraLLM,
  perfilRespaldoDisponible,
  verificarProveedorLLM,
} from '../../src/lib/mapa/cliente-llm'
import { forzarPerfil, getConfigActiva } from '../../src/config/modelos-pipeline'
import {
  comandos,
  ejecutarBrowser,
  esRefValido,
  extraerRefDeSnapshot,
  mismaPagina,
  parsearContenidoExtraido,
  resolverEjecutable,
  resolverHref,
  EjecutableNoEncontradoError,
} from '../../src/lib/pipeline/browser-cmd'
import { esDestinoPermitido } from '../../src/lib/pipeline/url-segura'
import { MEDIOS, type MedioConfig } from './medios-config'
import { obtenerContenidoLLM, formatearUso } from '../../src/lib/pipeline/llamada-llm'
import {
  parsearJsonLLM,
  validarLinksIdentificados,
} from '../../src/lib/pipeline/schemas-llm'
import { describirErrorProveedor, saludLLM } from '../../src/lib/pipeline/salud-llm'
import {
  describirAlcance,
  parametrosDesdeArgumentos,
  seleccionarMedios,
} from '../../src/lib/pipeline/opciones-corrida'
import { fechaArgentina, fechaDelHecho, horaArgentina } from '../../src/lib/pipeline/fechas'
import {
  claveProgramada,
  encolarCorrida,
  esOrigenValido,
  estadoFinal,
  finalizarCorrida,
  formatearEvento,
  programadaDeHoyCubierta,
  type ContadoresCorrida,
  type OrigenCorrida,
  type ProgresoCorrida,
  type ResultadoMedio,
  type ResumenCorrida,
} from '../../src/lib/pipeline/corridas'

// ════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════

/** Alcance, profundidad y modo de la corrida (argumentos + env vars históricas). */
const PARAMETROS = parametrosDesdeArgumentos(process.argv.slice(2))
const DRY_RUN = PARAMETROS.dryRun
/**
 * Noticias a visitar por medio. Antes se leía PIPELINE_MAX_NOTICIAS, se
 * mostraba en el log... y se ignoraba: el corte real era un `slice(0, 10)` fijo.
 */
const MAX_NOTICIAS = PARAMETROS.maxNoticias
const CONFIANZA_MINIMA = 75

/**
 * Override para medir con datos cuánto snapshot conviene mandar.
 *
 * El valor bueno para calidad de captura es 30000: un experimento medido
 * mostró El Día 1→7 noticias, Zona Oeste 2→6, Infobae 1→10 al subir de 3000 a
 * 30000. Pero 30000 en producción hoy es inaceptable en costo: la corrida del
 * 22/8 (66 medios, 79 min) ya mostraba 44% de extracciones tiradas por URL
 * duplicada y 37 timeouts de browser, y subir el snapshot llevaría la corrida
 * diaria a ~4-5 horas (ver plan bright-rolling-raccoon.md, Etapa 1).
 *
 * Por eso el default baja a 3000 hasta que el descubrimiento migre a feeds
 * RSS/sitemap (Etapa 4 del plan), momento en el que el LLM deja de tener que
 * "ver" el snapshot completo para encontrar links. El override por env var se
 * mantiene: es lo que permite seguir midiendo `--medio=X` con distintos
 * tamaños desde workflow_dispatch sin editar código entre corridas. El
 * workflow y el agente local usan 10000.
 */
const SNAPSHOT_MAX_CHARS = Number(process.env.PIPELINE_SNAPSHOT_MAX_CHARS) || 3000

/**
 * Si la corrida la lanzó el agente local, el agente es dueño de su fila en
 * corridas_pipeline (latido, log, estado final): el script solo emite eventos.
 * Si corre sola (Actions, línea de comandos), se registra ella misma.
 */
const CORRIDA_ID_EXTERNA = process.env.PIPELINE_CORRIDA_ID?.trim() || null
const ORIGEN: OrigenCorrida = esOrigenValido(process.env.PIPELINE_ORIGEN)
  ? process.env.PIPELINE_ORIGEN
  : 'cli'
/**
 * Modo respaldo de GitHub Actions: corre solo si la corrida programada del día
 * no la hizo ya el agente local. Ver programadaDeHoyCubierta().
 */
const SOLO_SI_NO_CORRIO_HOY = process.argv.includes('--solo-si-no-corrio-hoy')

/**
 * Sesión propia de agent-browser por corrida: una corrida manual al mismo
 * tiempo que el agente, o cualquier otro uso de agent-browser en la misma
 * computadora, no comparten pestañas con esta.
 */
process.env.AGENT_BROWSER_SESSION ||= `usina-pipeline-${process.pid}`

/**
 * Métricas por fase de la corrida, acumuladas a lo largo de todo el
 * pipeline y volcadas al resumen final.
 *
 * Sin esto no se puede comparar contra la línea de base: el diagnóstico del
 * 22/8 (79 min, 66 medios) se armó reconstruyendo tiempos a mano a partir del
 * espaciado de timestamps en los logs. Con estos acumuladores, la próxima
 * corrida deja el desglose ya calculado.
 */
const metricas = {
  tiempoBrowserMs: 0,
  tiempoIdentificacionLLMMs: 0,
  tiempoExtraccionLLMMs: 0,
  tiempoDedupMs: 0,
  llamadasLLM: {
    identificacion: 0,
    extraccion: 0,
  },
}

const contadores: ContadoresCorrida = {
  noticiasScrapeadas: 0,
  hechosExtraidos: 0,
  hechosNuevos: 0,
  coberturasVinculadas: 0,
  duplicados: 0,
  descartados: 0,
}

const progreso: ProgresoCorrida = {
  totalMedios: 0,
  medioIndice: 0,
  medio: null,
  fase: 'preparando',
  contadores,
}

// ════════════════════════════════════════════
// TIPOS
// ════════════════════════════════════════════

interface NoticiaScrapeada {
  titulo: string
  texto: string
  url: string
  medio: string
  medioTipo: 'provincial' | 'nacional'
  provinciaOrigen?: string
}

// ════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════

function log(emoji: string, msg: string, data?: unknown) {
  console.log(`${emoji} [${horaArgentina()}] ${msg}`)
  if (data) console.log('   ', JSON.stringify(data, null, 2))
}

const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Evento para el agente local (barra de progreso del panel). Solo se emite
 * cuando hay un agente escuchando: en los logs de Actions sería ruido.
 */
function emitirProgreso(cambios: Partial<Omit<ProgresoCorrida, 'contadores'>> = {}) {
  Object.assign(progreso, cambios)
  if (CORRIDA_ID_EXTERNA) console.log(formatearEvento({ tipo: 'progreso', progreso }))
}

/** Si el último comando de ab() anduvo. Para los pasos donde seguir a ciegas rompe algo. */
let ultimoAbOk = true
let ultimoAbError = ''

/**
 * Ejecuta agent-browser con argumentos separados y sin shell.
 *
 * Reemplaza al viejo `agentCmd(string)`, que concatenaba el comando y lo pasaba
 * a `execSync`: un `ref` elegido por el LLM a partir del snapshot de un sitio de
 * terceros llegaba a un shell con el entorno completo del proceso. Ahora los
 * comandos se construyen como arrays validados en src/lib/pipeline/browser-cmd.ts
 * y el subproceso recibe un entorno mínimo, sin credenciales.
 *
 * Devuelve stdout o cadena vacía si falló, para no cambiar el manejo de errores
 * de los llamadores; `ultimoAbOk` dice si el comando anduvo.
 *
 * Todas las operaciones de browser del pipeline pasan por acá, así que es el
 * único punto donde hay que medir para tener el tiempo de fase "browser"
 * completo (navegación, snapshots, clicks, waits, getUrl/getTexto...).
 */
function ab(args: readonly string[], timeoutMs: number = 30000): string {
  const inicio = Date.now()
  const r = ejecutarBrowser(args, { timeoutMs })
  metricas.tiempoBrowserMs += Date.now() - inicio
  ultimoAbOk = r.ok
  ultimoAbError = r.ok ? '' : (r.error ?? 'error desconocido')
  if (!r.ok && r.error) {
    log('⚠️', `agent-browser ${args[0]}: ${r.error.slice(0, 150)}`)
  }
  return r.salida
}

/**
 * Prompt de identificación de links.
 *
 * Es una función porque dos partes dependen de la corrida: cuántos resultados
 * se piden (la profundidad elegida) y, en una corrida enfocada desde el panel,
 * qué zonas priorizar. Dentro de una misma corrida el texto no cambia, así que
 * el caché de prompts del proveedor lo sigue aprovechando.
 */
function promptIdentificacion(maxResultados: number, foco: readonly string[]): string {
  const bloqueFoco = foco.length > 0
    ? `
PRIORIDAD GEOGRÁFICA DE ESTA CORRIDA:
El equipo está siguiendo de cerca estas zonas: ${foco.join(', ')}.
Listá PRIMERO las noticias que ocurran en esas zonas. Si queda lugar, incluí también las demás que cumplan los criterios.
`
    : ''

  return `Sos un analista experto en seguridad y noticias policiales de Argentina. Tu tarea es revisar un snapshot de un sitio web e identificar ÚNICAMENTE los enlaces (links) que correspondan a noticias de crímenes o hechos policiales donde haya una o más personas muertas por causas violentas o dudosas.

El periodismo argentino usa un lenguaje muy variado para referirse a muertes:
- Directo: "mataron", "asesinaron", "homicidio", "femicidio", "hallaron el cuerpo".
- Indirecto: "perdió la vida", "falleció tras el ataque", "no sobrevivió a las heridas", "fue encontrado sin vida", "trágico desenlace", "ajuste de cuentas", "baleado y muerto", "víctima fatal".
- Regional: "lo ultimaron", "lo ejecutaron", "cayó acribillado", "gatillo fácil con resultado muerte".

CRITERIOS DE INCLUSIÓN (Debe haber muerte confirmada o altamente probable):
- Homicidios, femicidios, transfemicidios, infanticidios.
- Ajustes de cuentas, linchamientos, tiroteos/balaceras con fallecidos.
- Cuerpos hallados con signos de violencia o en circunstancias dudosas.
- Muertes por violencia institucional (gatillo fácil).
- Accidentes de tránsito O incidentes viales SOLO si el título/enlace expresa explícitamente que hay víctimas fatales.

CRITERIOS DE EXCLUSIÓN ESTRICTA (Ignorar por completo):
- Robos, asaltos, secuestros, persecuciones o heridos graves SIN muerte confirmada.
- Detenciones, juicios, condenas, allanamientos o narcotráfico sin cadáveres.
- Suicidios (salvo que el contexto inicial sugiera dudas u homicidio oculto).
- Accidentes domésticos, incendios accidentales o muertes naturales.
- Todo lo ajeno a policiales (política, economía, deportes, espectáculos).
${bloqueFoco}
FORMATO DE SALIDA (ESTRICTO):
Respondé EXCLUSIVAMENTE con un JSON array válido.
NUNCA envuelvas la respuesta en bloques de código Markdown (no uses las tres comillas invertidas ni la palabra "json").
NUNCA agregues texto de introducción, saludos, notas aclaratorias ni texto de cierre. La respuesta debe empezar con [ y terminar con ].

Si no encontrás noticias que cumplan los criterios, devolvé exactamente un array vacío: []

Formato requerido:
[
  {"ref": "e42", "titulo": "Texto del link o titular exacto"}
]

SOBRE EL CAMPO "ref" (crítico):
- Es el identificador que el snapshot muestra junto a cada enlace, con la forma "e" seguida de números: e7, e42, e310.
- Copialo TEXTUAL del snapshot. No lo inventes, no lo renumeres, no lo completes.
- NUNCA pongas una URL, una ruta, un titular ni ningún otro texto en "ref".
- Si un enlace te interesa pero no ves su ref en el snapshot, omitilo: una entrada con un ref que no aparezca textual en el snapshot se descarta y la noticia se pierde.

Máximo ${maxResultados} resultados, ordenados de más a menos relevante.`
}

/**
 * Usa IA para identificar qué refs del snapshot son links a noticias
 * policiales/de seguridad.
 *
 * Esto reemplaza el parseo por regex y funciona en CUALQUIER sitio
 * sin configuración específica.
 *
 * Devuelve también el motivo cuando el medio se pierde por un problema (sin
 * respuesta del modelo, todo descartado): va al resumen de la corrida para
 * que "no había homicidios" y "no se pudo leer" no se confundan.
 */
async function identificarNoticiasConIA(
  snapshot: string,
  medio: string
): Promise<{ links: Array<{ ref: string; titulo: string }>; problema?: string }> {

  const { cliente, config } = crearClienteLLM('Mapa del Delito - Identificador')
  const modelo = config.modelo

  try {
    const resultado = await obtenerContenidoLLM({
      etiqueta: `identificación en ${medio}`,
      registrarUso: d => {
        const linea = formatearUso(d, `identificación en ${medio}`)
        if (linea) log('📊', linea)
      },
      // Tiene que ser un array JSON. Si vino cortado, reintentar.
      aceptar: contenido => {
        const p = parsearJsonLLM(contenido)
        return p.ok && Array.isArray(p.valor)
      },
      ejecutar: () => cliente.chat.completions.create({
        model: modelo,
        messages: [
          { role: 'system', content: promptIdentificacion(MAX_NOTICIAS, PARAMETROS.foco) },
          {
            role: 'user',
            // Los refs SOLO existen dentro del snapshot, así que el modelo no
            // puede nombrar ningún enlace que caiga después del corte: con
            // 3000 chars de una portada se veía el logo, el menú y las
            // primeras notas. Un snapshot cortado a la mitad de un ref es
            // justo la situación en la que el modelo improvisa un ref inválido.
            // No bajarlo sin medir los prompt_tokens reales que quedan en los logs.
            content: `Snapshot del sitio ${medio}:\n\n${snapshot.slice(0, SNAPSHOT_MAX_CHARS)}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 800,
        ...(parametrosExtraLLM(config) as object),
      }),
    })

    // ANTES esto era `content?.trim() || '[]'`: una respuesta vacía del modelo
    // se convertía en silencio en "este medio no tiene noticias", sin un solo
    // log. Un medio entero se perdía sin dejar rastro, y en los logs quedaba
    // indistinguible de "revisé y no había homicidios".
    if (!resultado.ok) {
      log('⚠️', `Identificación en ${medio}: SIN RESPUESTA USABLE tras ${resultado.intentos} intentos (${resultado.motivo}) — NO es lo mismo que "no hay noticias"`)
      return { links: [], problema: `sin respuesta usable del LLM (${resultado.motivo.slice(0, 160)})` }
    }

    const parseado = parsearJsonLLM(resultado.contenido)
    if (!parseado.ok) {
      log('⚠️', `Identificación en ${medio}: respuesta no parseable — ${parseado.errores.join('; ')}`)
      return { links: [], problema: 'respuesta del LLM no parseable' }
    }

    // Valida cada entrada y descarta las que no cumplen, en lugar de aceptar el
    // array crudo. Antes un ref con metacaracteres pasaba directo al comando.
    const { links, descartados } = validarLinksIdentificados(parseado.valor, MAX_NOTICIAS)
    if (descartados.length > 0) {
      // Se distingue "descarté algunas" de "descarté TODAS": lo segundo es un
      // medio entero perdido. Fue exactamente el caso de El Independiente La
      // Rioja: 10 identificadas, 10 descartadas, cero rastro.
      if (links.length === 0) {
        log('🚨', `Identificación en ${medio}: SE DESCARTARON LAS ${descartados.length} ENTRADAS — el medio se pierde completo, NO es lo mismo que "no hay noticias"`)
        for (const d of descartados.slice(0, 5)) log('  ', d)
        return { links, problema: `se descartaron las ${descartados.length} entradas del LLM` }
      }
      log('⚠️', `Identificación en ${medio}: ${descartados.length} entrada(s) descartada(s) de ${descartados.length + links.length}`)
      for (const d of descartados.slice(0, 5)) log('  ', d)
    }
    return { links }

  } catch (error) {
    const err = error as { message?: string; status?: number }
    log('⚠️', `Error en identificación IA (${medio}): ${err.status ?? ''} ${err.message ?? String(error)}`)
    return { links: [], problema: `error en la identificación: ${err.message ?? String(error)}` }
  }
}

/**
 * Pre-warm del daemon de agent-browser.
 * La primera ejecución levanta Chromium y puede tardar 30-60 segundos.
 * Haciendo open about:blank primero, las navegaciones reales son rápidas.
 */
function prewarmDaemon(): boolean {
  log('🔥', 'Pre-warming agent-browser daemon...')
  const result = ab(comandos.abrirEnBlanco(), 90000) // 90s para cold-start
  if (result === '') {
    // Puede devolver vacío pero funcionar igual, verificar con get url
    const url = ab(comandos.getUrl(), 5000)
    if (!url) {
      log('❌', 'No se pudo iniciar agent-browser')
      return false
    }
  }
  log('✅', 'Daemon listo')
  return true
}

/** Cierra la pestaña de detalle y vuelve al listado. */
async function volverAlListado() {
  ab(comandos.cerrarTab())
  await dormir(300)
  ab(comandos.tab(0))
}

/**
 * Scrapea un medio usando el Tab Isolation Pattern.
 *
 * Flujo (basado en issue #853 de agent-browser):
 * 1. Navegar a la sección policial en tab 0
 * 2. Snapshot -i para obtener refs de links
 * 3. Para cada link:
 *    - leer su href: si ya está en la base o apunta a un destino prohibido,
 *      se descarta SIN navegar
 *    - click @ref --new-tab (abre en tab nueva) y tab 1
 *    - Extraer título y texto del artículo en una sola llamada
 *    - tab close y tab 0 (volver al listado, refs intactos)
 */
async function scrapearMedio(
  medio: MedioConfig
): Promise<{ noticias: NoticiaScrapeada[]; duplicadasTempranas: number; resultado: ResultadoMedio }> {
  const urlTarget = medio.urlPoliciales || medio.url || ''
  log('📰', `Scrapeando ${medio.nombre} (${urlTarget})`)
  const noticias: NoticiaScrapeada[] = []
  const resultado: ResultadoMedio = { medio: medio.nombre, identificadas: 0, extraidas: 0 }
  let duplicadasTempranas = 0

  try {
    // 1. Navegar a la sección policial
    ab(comandos.abrir(urlTarget), 30000)
    if (!ultimoAbOk) {
      const errorApertura = ultimoAbError
      // Un `open` que falla deja la página de error de Chrome, y su snapshot
      // NO viene vacío: sin este chequeo el medio caído se contaba como "sin
      // noticias" y la corrida no se enteraba de que el browser no llegaba a
      // ningún lado. Si igual cargó algo (un timeout con la página a medias),
      // se sigue.
      const donde = ab(comandos.getUrl(), 5000)
      if (!donde || donde.startsWith('chrome-error://') || donde === 'about:blank') {
        const motivo = errorApertura.replace(/\s+/g, ' ').trim().slice(0, 120) || 'error de navegación'
        log('⚠️', `No se pudo abrir ${medio.nombre}: ${motivo}`)
        resultado.problema = `no se pudo abrir la sección (${motivo})`
        return { noticias, duplicadasTempranas, resultado }
      }
    }
    ab(comandos.esperarCarga(), 20000)

    // 2. Snapshot interactivo para obtener refs de links
    const snapshot = ab(comandos.snapshotInteractivo(), 15000)

    if (!snapshot) {
      log('⚠️', `No se pudo obtener snapshot de ${medio.nombre}`)
      resultado.problema = 'no se pudo abrir la sección (sin snapshot)'
      return { noticias, duplicadasTempranas, resultado }
    }

    // La URL real del listado (después de redirecciones), para resolver hrefs
    // relativos y para reconocer si un click nos dejó en la misma página.
    const urlListado = ab(comandos.getUrl(), 5000) || urlTarget

    // 3. Identificar noticias policiales con IA (funciona en cualquier sitio)
    log('🤖', `Identificando noticias policiales con IA en ${medio.nombre}...`)
    emitirProgreso({ fase: 'identificando' })
    const inicioIdentificacion = Date.now()
    const identificacion = await identificarNoticiasConIA(snapshot, medio.nombre)
    metricas.tiempoIdentificacionLLMMs += Date.now() - inicioIdentificacion
    metricas.llamadasLLM.identificacion++

    const linksNoticias = identificacion.links
    resultado.identificadas = linksNoticias.length
    if (identificacion.problema) resultado.problema = identificacion.problema

    log('🔗', `${linksNoticias.length} noticias policiales identificadas en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      if (!identificacion.problema) log('⚠️', `No se encontraron noticias policiales en ${medio.nombre}`)
      return { noticias, duplicadasTempranas, resultado }
    }

    // 4. Visitar cada noticia con Tab Isolation Pattern
    emitirProgreso({ fase: 'navegando' })
    for (const link of linksNoticias.slice(0, MAX_NOTICIAS)) {
      try {
        // Re-snapshot y buscar ref fresco por título. extraerRefDeSnapshot usa
        // una regex fija y valida el formato; no compila el título del LLM.
        const freshSnapshot = ab(comandos.snapshotInteractivo(), 10000)
        const refFresco = extraerRefDeSnapshot(freshSnapshot, link.titulo)

        // Si no se encontró en el snapshot fresco se cae al ref que devolvió el
        // LLM, pero solo si cumple ^e[0-9]+$. Un ref con metacaracteres se
        // descarta: antes llegaba concatenado a un shell.
        const currentRef = refFresco ?? (esRefValido(link.ref) ? link.ref : null)

        if (!currentRef) {
          log('⏭️', `Ref inválido o no encontrado, se descarta: ${link.titulo.slice(0, 50)}`)
          continue
        }

        // ¿Adónde apunta el link? Se pregunta ANTES del click: si el destino
        // está prohibido o ya está en la base, no hace falta navegar. En la
        // corrida del 6/9, 17 de 44 links eran notas ya registradas; antes
        // cada una costaba abrirla para recién ahí descubrirlo.
        const destino = resolverHref(ab(comandos.getHref(currentRef), 5000), urlListado)
        if (destino) {
          if (!esDestinoPermitido(destino)) {
            log('🛑', `Link a destino no permitido, no se abre: ${destino.slice(0, 120)}`)
            continue
          }
          if (await urlYaRegistrada(destino)) {
            log('⏭️', `URL ya procesada (sin abrirla): ${destino.slice(0, 80)}`)
            duplicadasTempranas++
            continue
          }
        }

        // Abrir en tab nueva (tab 0 queda intacta) y pasar a la tab 1.
        ab(comandos.clickNuevaTab(currentRef))
        await dormir(1000)
        ab(comandos.tab(1))
        if (!ultimoAbOk) {
          // Algunas pestañas tardan en crearse: un segundo intento.
          await dormir(2000)
          ab(comandos.tab(1))
        }
        if (!ultimoAbOk) {
          // Si la nota no se abrió en otra pestaña, seguir leería la PORTADA
          // como si fuera la nota — y después cerraría el listado (la tab 0).
          log('⏭️', `La nota no se abrió en otra pestaña, se descarta: ${link.titulo.slice(0, 50)}`)
          const actual = ab(comandos.getUrl(), 5000)
          if (actual && !mismaPagina(actual, urlListado)) {
            // El click navegó la propia tab 0: se vuelve al listado.
            ab(comandos.abrir(urlTarget), 30000)
            ab(comandos.esperarCarga(), 20000)
          }
          continue
        }
        ab(comandos.esperarCarga(), 5000)

        // Obtener URL del artículo
        const urlArticulo = ab(comandos.getUrl())

        if (!urlArticulo || mismaPagina(urlArticulo, urlListado)) {
          log('⏭️', `El click no llevó a una nota distinta del listado: ${link.titulo.slice(0, 50)}`)
          await volverAlListado()
          continue
        }

        // ¿Dónde aterrizamos realmente?
        //
        // El href ya se validó, pero un redirect o un link manejado por JS
        // puede llevar a otro lado: cualquiera que consiga poner un <a href>
        // en esa portada —una nota patrocinada, un widget de terceros
        // comprometido— elige a qué se conecta el browser. El destino
        // clásico es 169.254.169.254, el endpoint de metadatos de la nube.
        //
        // Se comprueba ACÁ, antes de extraer el texto, porque lo que se
        // extrae termina en el prompt del modelo y en la base.
        if (!esDestinoPermitido(urlArticulo)) {
          log('🛑', `Destino no permitido tras el click, se descarta: ${urlArticulo.slice(0, 120)}`)
          ab(comandos.cerrarTab())
          ab(comandos.tab(0))
          continue
        }

        // ¿Ya está esta URL en la base? (la del destino final: el href podía
        // ser una redirección). En producción el 44% de las extracciones
        // terminaban descartadas por "URL ya procesada": se pagaba texto + LLM
        // completo para descubrir al final algo que ya sabíamos.
        if (await urlYaRegistrada(urlArticulo)) {
          log('⏭️', `URL ya procesada (se evita extracción): ${urlArticulo.slice(0, 60)}`)
          duplicadasTempranas++
          ab(comandos.cerrarTab())
          ab(comandos.tab(0))
          continue
        }

        // Título y texto en una sola llamada (antes: hasta 14 `get text`).
        const contenido = parsearContenidoExtraido(ab(comandos.extraerContenido(), 10000))
        const titulo = contenido.titulo || ab(comandos.getTitulo()) || link.titulo
        let texto = contenido.texto

        // Fallback: snapshot compacto de main
        if (!texto || texto.length < 100) {
          const snapMain = ab(comandos.snapshotSelector('main'), 5000)
          if (snapMain && snapMain.length > 100) {
            texto = snapMain.slice(0, 8000)
          }
        }

        // Cerrar tab de detalle, volver a tab 0
        await volverAlListado()

        if (titulo && texto && texto.length > 80) {
          noticias.push({
            titulo: titulo.trim(),
            // 8000 para dejar margen sobre los 6000 que openrouter.ts manda
            // al modelo. Antes eran 5000 acá y 3000 allá: se guardaban 2000
            // chars que nunca llegaban a leerse.
            texto: texto.trim().slice(0, 8000),
            url: urlArticulo,
            medio: medio.nombre,
            medioTipo: medio.tipo ?? (medio.provincia && medio.provincia !== 'Nacional' ? 'provincial' : 'nacional'),
            provinciaOrigen: medio.provincia,
          })
          log('✅', `  ${titulo.slice(0, 60)}...`)
        } else {
          log('⏭️', `  Texto insuficiente: ${link.titulo.slice(0, 40)}`)
        }

      } catch (error) {
        log('⚠️', `Error en noticia: ${String(error).slice(0, 100)}`)
        // Intentar recuperar: cerrar tabs extras y volver a tab 0
        try {
          ab(comandos.cerrarTab())
          ab(comandos.tab(0))
        } catch (_e2) { /* ignorar */ }
      }

      // Rate limiting entre noticias: cortesía con el sitio del medio.
      await dormir(2000)
    }

    log('📊', `${medio.nombre}: ${noticias.length} noticias extraídas`)
    return { noticias, duplicadasTempranas, resultado }

  } catch (error) {
    log('❌', `Error general en ${medio.nombre}: ${String(error).slice(0, 150)}`)
    resultado.problema = `error general: ${String(error).slice(0, 150)}`
  }

  return { noticias, duplicadasTempranas, resultado }
}

// ════════════════════════════════════════════
// GEORREFERENCIACIÓN
// ════════════════════════════════════════════

const GEOREF = 'https://apis.datos.gob.ar/georef/api'

interface Georreferencia {
  provinciaId: string
  latitud: number
  longitud: number
  /** Nombre oficial del departamento si se encontró; null si quedó a nivel provincia. */
  departamento: string | null
  precision: 'georef:departamento' | 'georef:provincia'
}

/**
 * GET a Georef con timeout y chequeo de estado. Antes era un fetch pelado: sin
 * timeout (una API lenta colgaba la corrida) y sin mirar `res.ok` (un 429 o un
 * 5xx terminaba en un `.json()` que explotaba después de haber pagado la
 * extracción de la nota).
 */
async function georefJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      log('⚠️', `Georef respondió ${res.status} para ${url.slice(0, 100)}`)
      return null
    }
    return (await res.json()) as T
  } catch (error) {
    log('⚠️', `Georef no respondió: ${String(error).slice(0, 100)}`)
    return null
  }
}

/** Las provincias son 24: se consultan una vez por corrida, no dos por noticia. */
const cacheProvincias = new Map<string, { id: string; lat: number; lon: number } | null>()

async function georreferenciar(
  provincia: string | null,
  ciudad: string | null,
): Promise<Georreferencia | null> {
  if (!provincia) return null

  const claveProvincia = provincia.trim().toLowerCase()
  let prov = cacheProvincias.get(claveProvincia)
  if (prov === undefined) {
    const data = await georefJson<{ provincias?: Array<{ id: string; centroide?: { lat: number; lon: number } }> }>(
      `${GEOREF}/provincias?nombre=${encodeURIComponent(provincia)}&max=1`
    )
    const p = data?.provincias?.[0]
    prov = p?.centroide ? { id: p.id, lat: p.centroide.lat, lon: p.centroide.lon } : null
    // Un fallo de red no se cachea: la próxima noticia puede tener más suerte.
    if (data) cacheProvincias.set(claveProvincia, prov)
  }
  if (!prov) return null

  // Si hay ciudad, buscar departamento para mejor precisión
  if (ciudad) {
    const data = await georefJson<{ departamentos?: Array<{ nombre: string; centroide?: { lat: number; lon: number } }> }>(
      `${GEOREF}/departamentos?nombre=${encodeURIComponent(ciudad)}&provincia=${prov.id}&max=1`
    )
    const dep = data?.departamentos?.[0]
    if (dep?.centroide) {
      return {
        provinciaId: prov.id,
        latitud: dep.centroide.lat,
        longitud: dep.centroide.lon,
        departamento: dep.nombre,
        precision: 'georef:departamento',
      }
    }
  }

  // Fallback: centroide de la provincia
  return {
    provinciaId: prov.id,
    latitud: prov.lat,
    longitud: prov.lon,
    departamento: null,
    precision: 'georef:provincia',
  }
}

// ════════════════════════════════════════════
// PROCESAMIENTO DE UNA NOTICIA
// ════════════════════════════════════════════

interface ContextoInsercion {
  fuenteId: string
  tipoPorCodigo: Map<string, { id: string }>
}

async function procesarNoticia(noticia: NoticiaScrapeada, ctx: ContextoInsercion): Promise<void> {
  const { tipoPorCodigo } = ctx

  // ── Extracción IA ──
  log('🤖', `Extrayendo datos de: ${noticia.titulo.slice(0, 60)}...`)
  const inicioExtraccion = Date.now()
  const datos = await extraerDatosNoticia(noticia.texto, noticia.url)
  metricas.tiempoExtraccionLLMMs += Date.now() - inicioExtraccion
  metricas.llamadasLLM.extraccion++

  if (!datos.esHechoDelictivo) {
    log('⏭️', `No es hecho delictivo: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
    contadores.descartados++
    return
  }

  if (datos.confianzaExtraccion < CONFIANZA_MINIMA) {
    log('⏭️', `Confianza baja (${datos.confianzaExtraccion}%): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
    contadores.descartados++
    return
  }

  if (datos.codigoSnicEstimado !== null &&
      ![0, 1, 2, 3, 4].includes(datos.codigoSnicEstimado)) {
    log('⏭️', `Código SNIC inválido para homicidios: ${datos.codigoSnicEstimado} — "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
    contadores.descartados++
    return
  }

  contadores.hechosExtraidos++

  // ── Deduplicación inteligente ──
  // Se mide el tiempo de la fase completa, no una llamada LLM garantizada:
  // deduplicar() solo consulta al modelo cuando el caso es ambiguo (ver el
  // comentario en deduplicador.ts), así que no se suma a llamadasLLM.
  const inicioDedup = Date.now()
  const dedup = await deduplicar({
    tipoHecho: datos.tipoHecho || '',
    // != null y no la verdad del valor: el código SNIC 0 es válido y falsy.
    codigoSnicEstimado: datos.codigoSnicEstimado != null ? String(datos.codigoSnicEstimado) : '',
    ubicacion: datos.ubicacion,
    fecha: datos.fecha,
    titulo: noticia.titulo,
    resumen: datos.descripcionBreve,
    medio: noticia.medio,
    medioTipo: noticia.medioTipo,
    url: noticia.url,
    nombreVictima: datos.nombreVictima,
  })
  metricas.tiempoDedupMs += Date.now() - inicioDedup

  if (dedup.urlDuplicada) {
    log('⏭️', `URL ya procesada: ${noticia.url.slice(0, 50)}`)
    contadores.duplicados++
    return
  }

  // ── Georreferenciación ──
  const provinciaParaGeoref = datos.ubicacion.provincia || noticia.provinciaOrigen || null
  const geo = await georreferenciar(provinciaParaGeoref, datos.ubicacion.ciudad)

  if (!geo) {
    log('⚠️', `No se pudo georreferenciar (${provinciaParaGeoref}): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
    contadores.descartados++
    return
  }

  // Mapear tipo de delito — sin default, el LLM debe asignar código
  // != null, NO la verdad del valor. El código SNIC 0 ("muerte violenta en
  // investigación") es válido y es falsy en JS, así que con `? :` el lookup
  // nunca corría y la noticia se descartaba.
  const tipoDelito = datos.codigoSnicEstimado != null
    ? tipoPorCodigo.get(String(datos.codigoSnicEstimado))
    : null

  if (!tipoDelito) {
    log('⚠️', `Código SNIC ${datos.codigoSnicEstimado ?? 'null'} no mapeado: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
    contadores.descartados++
    return
  }

  // Fecha del hecho en hora argentina: con `new Date('2026-01-01')` corriendo
  // en una PC de Argentina el hecho quedaba en diciembre del año anterior.
  const { fecha: fechaHecho, anio, mes } = fechaDelHecho(datos.fecha)

  // ── DRY RUN: solo mostrar ──
  if (DRY_RUN) {
    log('🔍', `[DRY RUN] ${dedup.esNuevo ? 'NUEVO' : 'COBERTURA'}: ${datos.tipoHecho} | SNIC:${datos.codigoSnicEstimado} | ${provinciaParaGeoref} | confianza:${datos.confianzaExtraccion}% | revision:${(datos.requiereRevision || dedup.requiereRevision) ? '⚠️ SI' : 'no'} | ${noticia.url}`)
    if (dedup.esNuevo) contadores.hechosNuevos++
    else contadores.coberturasVinculadas++
    return
  }

  // ── INSERCIÓN REAL ──
  if (dedup.esNuevo) {
    // CASO A: Hecho nuevo → HechoDelictivo + primera CoberturaMediatica
    log('🆕', `Hecho NUEVO (${dedup.confianza}%): ${noticia.titulo.slice(0, 50)}`)

    // Etiqueta de la ubicación: el departamento oficial si Georef lo encontró;
    // si no, la localidad que dio la nota (las coordenadas son las de la
    // provincia, y fuente_ubicacion lo dice).
    const etiqueta = geo.departamento ?? datos.ubicacion.ciudad ?? null

    // Buscar o crear ubicación. La etiqueta entra en la búsqueda: antes se
    // buscaba solo por coordenadas, y como toda nota sin departamento cae en
    // el centroide de su provincia, la segunda nota de "Quilmes" reusaba la
    // ubicación creada por la primera de "La Matanza" y quedaba con ese nombre.
    let ubicacion = await prisma.ubicacion.findFirst({
      where: {
        provinciaId: geo.provinciaId,
        latitud: geo.latitud,
        longitud: geo.longitud,
        departamento: etiqueta,
        fuenteUbicacion: geo.precision,
      }
    })

    if (!ubicacion) {
      ubicacion = await prisma.ubicacion.create({
        data: {
          provincia: provinciaParaGeoref || 'Desconocida',
          provinciaId: geo.provinciaId,
          departamento: etiqueta,
          localidad: datos.ubicacion.barrio,
          direccion: datos.ubicacion.direccion,
          latitud: geo.latitud,
          longitud: geo.longitud,
          fuenteUbicacion: geo.precision,
          // Siempre false para el pipeline. `es_centroide = true` marca las
          // filas CANÓNICAS de cada provincia: getProvincias() las lista como
          // catálogo y actualizar-centroides.ts las mueve. Antes una nota sin
          // ciudad creaba una fila así y ensuciaba el listado de provincias.
          esCentroide: false,
        }
      })
    }

    // El hecho y su primera cobertura van en una transacción: si la
    // cobertura falla (url es @unique, puede colisionar con una corrida
    // concurrente) el hecho no queda huérfano en la cola de revisión
    // sin ninguna fuente que el revisor pueda leer.
    await prisma.$transaction(async (tx) => {
      const hecho = await tx.hechoDelictivo.create({
        data: {
          tipoDelitoId: tipoDelito.id,
          fechaHecho: fechaHecho,
          anio,
          mes,
          ubicacionId: ubicacion!.id,
          cantidadVictimas: datos.cantidadVictimas || 1,
          cantidadHechos: 1,
          medioUtilizado: datos.medioUtilizado,
          fuenteId: ctx.fuenteId,
          confianza: 'PRELIMINAR',
          urlFuente: noticia.url,
          esAgregado: false,
          esCasoUsina: false,
          // Dos señales distintas piden revisión, y ninguna reemplaza a
          // la otra: la extracción puede estar segura del hecho pero la
          // deduplicación no pudo confirmar si es nuevo — o al revés.
          requiereRevision: (datos.requiereRevision ?? false) || dedup.requiereRevision,
          nombreVictima: datos.nombreVictima ?? null,
          // 'Si' o null, igual formato que escribe la ingesta oficial del
          // SAT, para que las vistas que cuentan femicidio = 'Si' incluyan
          // también los casos del pipeline.
          femicidio: datos.esFemicidio ? 'Si' : null,
        }
      })

      await tx.coberturaMediatica.create({
        data: {
          hechoDelictivoId: hecho.id,
          medio: noticia.medio,
          medioTipo: noticia.medioTipo,
          titulo: noticia.titulo,
          url: noticia.url,
          fechaPublicacion: new Date(),
          resumen: datos.descripcionBreve,
          tipoCobertura: 'HECHO_INICIAL',
        }
      })
    })

    contadores.hechosNuevos++

  } else {
    // CASO B: Cobertura de hecho existente → solo CoberturaMediatica
    log('📎', `Cobertura existente (${dedup.razon}): ${noticia.titulo.slice(0, 50)}`)

    const tipoCobertura = clasificarCobertura(noticia.titulo, noticia.texto)
    const hechoId = dedup.hechoDelictivoId!

    // La cobertura y la promoción van juntas: el conteo es un
    // read-modify-write y dos corridas concurrentes podrían dejar el
    // hecho sin promover pese a superar el umbral.
    const promovido = await prisma.$transaction(async (tx) => {
      await tx.coberturaMediatica.create({
        data: {
          hechoDelictivoId: hechoId,
          medio: noticia.medio,
          medioTipo: noticia.medioTipo,
          titulo: noticia.titulo,
          url: noticia.url,
          fechaPublicacion: new Date(),
          resumen: datos.descripcionBreve,
          tipoCobertura: tipoCobertura as 'HECHO_INICIAL' | 'ACTUALIZACION' | 'DETENCION' | 'MARCHA_RECLAMO' | 'PROCESO_JUDICIAL' | 'SENTENCIA' | 'ANIVERSARIO' | 'OPINION_EDITORIAL',
        }
      })

      // Promoción automática a VERIFICADO: 3+ coberturas de 2+ medios.
      //
      // Antes bastaban 3 coberturas cualesquiera, y eso:
      // - pisaba decisiones humanas: un caso que un revisor marcó "no es
      //   homicidio" volvía a VERIFICADO con su tercera nota;
      // - sacaba de la cola casos que nadie miró, incluidos los marcados
      //   requiere_revision y los de código 0 (causa sin determinar);
      // - contaba tres notas del MISMO medio como verificación cruzada,
      //   cuando el esquema define VERIFICADO como "cruzado entre 2+ fuentes".
      const hecho = await tx.hechoDelictivo.findUnique({
        where: { id: hechoId },
        select: { confianza: true, requiereRevision: true, tipoDelito: { select: { codigoSnic: true } } },
      })
      if (!hecho || hecho.confianza !== 'PRELIMINAR' || hecho.requiereRevision || hecho.tipoDelito.codigoSnic === '0') {
        return false
      }
      const coberturas = await tx.coberturaMediatica.findMany({
        where: { hechoDelictivoId: hechoId },
        select: { medio: true },
      })
      const mediosDistintos = new Set(coberturas.map(c => c.medio)).size
      if (coberturas.length < 3 || mediosDistintos < 2) return false

      // La revisión humana manda: si alguien ya lo clasificó, no se toca.
      const revisiones = await tx.$queryRaw<Array<{ existe: number }>>`
        SELECT 1 AS existe FROM revisiones_pipeline WHERE hecho_id = ${hechoId} LIMIT 1
      `
      if (revisiones.length > 0) return false

      await tx.hechoDelictivo.update({
        where: { id: hechoId },
        data: { confianza: 'VERIFICADO' }
      })
      return true
    })

    if (promovido) {
      log('✅', `Hecho promovido a VERIFICADO (3+ coberturas de 2+ medios)`)
    }

    contadores.coberturasVinculadas++
  }

  // Rate limiting entre llamadas al proveedor LLM
  await dormir(1000)
}

// ════════════════════════════════════════════
// PROVEEDOR LLM
// ════════════════════════════════════════════

/**
 * Verifica el proveedor antes de empezar y, si no responde, prueba con el
 * perfil de respaldo (si tiene credenciales). Ver verificarProveedorLLM().
 */
async function prepararProveedorLLM(): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const principal = await verificarProveedorLLM()
  for (const aviso of principal.avisos) log('⚠️', aviso)
  if (principal.ok) {
    log('✅', `Proveedor LLM responde: ${principal.config.descripcion} (${principal.ms} ms)`)
    return { ok: true }
  }

  const detalle = describirErrorProveedor(principal.status, principal.mensaje)
  log('🚨', `El proveedor LLM rechazó la llamada de prueba (${principal.config.descripcion}): ${detalle}`)

  const respaldo = perfilRespaldoDisponible()
  if (!respaldo) {
    return {
      ok: false,
      motivo: `El proveedor LLM no responde (${principal.config.descripcion}): ${detalle}. ` +
        'No hay perfil de respaldo con credenciales (PIPELINE_PERFIL_RESPALDO u OPENROUTER_API_KEY).',
    }
  }

  forzarPerfil(respaldo)
  const alternativo = await verificarProveedorLLM()
  for (const aviso of alternativo.avisos) log('⚠️', aviso)
  if (alternativo.ok) {
    log('🛟', `Se sigue con el perfil de respaldo "${respaldo}": ${alternativo.config.descripcion}`)
    return { ok: true }
  }
  forzarPerfil(null)
  return {
    ok: false,
    motivo: `No responde ni el proveedor principal (${detalle}) ni el respaldo "${respaldo}" ` +
      `(${describirErrorProveedor(alternativo.status, alternativo.mensaje)})`,
  }
}

// ════════════════════════════════════════════
// REGISTRO DE LA CORRIDA
// ════════════════════════════════════════════

/** Fila propia en corridas_pipeline (solo cuando no la maneja el agente). */
let corridaPropiaId: string | null = null

async function registrarCorridaPropia(): Promise<void> {
  if (CORRIDA_ID_EXTERNA) return
  try {
    const datos = {
      origen: ORIGEN,
      parametros: PARAMETROS,
      enCursoPor: ORIGEN === 'github-actions' ? 'github-actions' : `cli@${process.pid}`,
    }
    // El respaldo de Actions toma la clave del día: si el agente local se
    // enciende más tarde, ve que la programada ya se hizo y no la repite.
    const corrida = SOLO_SI_NO_CORRIO_HOY
      ? (await encolarCorrida(prisma, { ...datos, claveUnica: claveProgramada(fechaArgentina()) }))
        ?? (await encolarCorrida(prisma, datos))
      : await encolarCorrida(prisma, datos)
    corridaPropiaId = corrida?.id ?? null
  } catch (error) {
    // Sin la tabla (migración no aplicada) la corrida sigue igual: el
    // historial del panel es un extra, no una condición para scrapear.
    log('⚠️', `No se pudo registrar la corrida en el historial: ${String(error).slice(0, 150)}`)
  }
}

async function finalizarCorridaPropia(resumen: ResumenCorrida | null, exitCode: number, cancelada = false) {
  if (!corridaPropiaId) return
  try {
    const { estado, error } = estadoFinal(exitCode, cancelada, resumen)
    await finalizarCorrida(prisma, corridaPropiaId, { estado, resumen, error, exitCode, progreso })
  } catch (error) {
    log('⚠️', `No se pudo cerrar la corrida en el historial: ${String(error).slice(0, 150)}`)
  }
}

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

let browserIniciado = false

async function main(): Promise<number> {
  log('🚀', 'Pipeline de Medios Periodísticos')
  log('⚙️', `Modo: ${DRY_RUN ? '🔍 DRY RUN' : '💾 ESCRITURA REAL'}`)
  log('⚙️', `Alcance: ${describirAlcance(PARAMETROS)}`)
  log('⚙️', `Máximo noticias por medio: ${MAX_NOTICIAS}`)
  log('⚙️', `Confianza mínima: ${CONFIANZA_MINIMA}%`)
  log('⚙️', `Origen: ${ORIGEN}${CORRIDA_ID_EXTERNA ? ' (agente local)' : ''}`)

  // Respaldo de Actions: si la programada de hoy ya la cubrió el agente
  // local, no hay nada que hacer.
  if (SOLO_SI_NO_CORRIO_HOY) {
    try {
      const { cubierta, detalle } = await programadaDeHoyCubierta(prisma, fechaArgentina())
      if (cubierta) {
        log('✅', `No hace falta correr el respaldo: ${detalle}`)
        return 0
      }
      log('▶️', `Corre el respaldo: ${detalle}`)
    } catch (error) {
      log('⚠️', `No se pudo consultar el historial de corridas (${String(error).slice(0, 120)}); se corre igual`)
    }
  }

  // Filtrar medios según el alcance pedido
  const { seleccionados: medios, desconocidos } = seleccionarMedios(MEDIOS, PARAMETROS)
  if (desconocidos.length > 0) log('⚠️', `Medios desconocidos, se ignoran: ${desconocidos.join(', ')}`)

  if (medios.length === 0) {
    log('❌', 'Ningún medio coincide con el alcance pedido')
    log('📋', 'Medios disponibles:', MEDIOS.map(m => m.id))
    return 1
  }

  log('📰', `Medios a scrapear (${medios.length}): ${medios.map(m => m.nombre).join(', ')}`)
  emitirProgreso({ totalMedios: medios.length, fase: 'verificando-llm' })
  await registrarCorridaPropia()

  const resultadosMedios: ResultadoMedio[] = []
  let motivoFallo: string | undefined

  // ── Proveedor LLM: antes de gastar un solo minuto de browser ──
  const proveedor = await prepararProveedorLLM()
  if (!proveedor.ok) {
    motivoFallo = proveedor.motivo
  } else {
    motivoFallo = await recorrerMedios(medios, resultadosMedios)
  }

  // ── Resumen final ──
  const llm = saludLLM.resumen()
  if (!motivoFallo && saludLLM.sinNingunExito()) {
    motivoFallo = `ninguna de las ${llm.llamadas} llamadas al LLM tuvo éxito` +
      (llm.ultimoError ? ` (último error: ${describirErrorProveedor(llm.ultimoError.status, llm.ultimoError.mensaje)})` : '')
  }
  const sinSnapshot = resultadosMedios.filter(r => r.problema?.startsWith('no se pudo abrir')).length
  if (!motivoFallo && resultadosMedios.length > 0 && sinSnapshot === resultadosMedios.length) {
    motivoFallo = 'el browser no pudo abrir ninguno de los medios'
  }

  const resumen: ResumenCorrida = {
    ...contadores,
    modo: DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN',
    estado: motivoFallo ? 'fallida' : 'ok',
    ...(motivoFallo ? { motivoFallo } : {}),
    perfilLLM: getConfigActiva().descripcion,
    llm,
    medios: resultadosMedios,
    tiemposMs: {
      browser: metricas.tiempoBrowserMs,
      identificacionLLM: metricas.tiempoIdentificacionLLMMs,
      extraccionLLM: metricas.tiempoExtraccionLLMMs,
      dedup: metricas.tiempoDedupMs,
    },
    llamadasLLM: { ...metricas.llamadasLLM },
  }

  emitirProgreso({ fase: 'finalizando' })
  log('', '═'.repeat(60))
  if (motivoFallo) log('🚨', `Pipeline FALLIDO: ${motivoFallo}`)
  else log('🎉', 'Pipeline completado')
  log('📊', 'Resumen:', {
    noticiasScrapeadas: contadores.noticiasScrapeadas,
    hechosExtraidos: contadores.hechosExtraidos,
    hechosNuevos: contadores.hechosNuevos,
    coberturasVinculadas: contadores.coberturasVinculadas,
    duplicados: contadores.duplicados,
    descartados: contadores.descartados,
    modo: resumen.modo,
    estado: resumen.estado,
    // Tiempos por fase y llamadas al LLM — sin esto no se puede comparar
    // contra la línea de base (79 min, 66 medios, 22/8). Ver el comentario
    // en la constante `metricas`.
    tiemposMs: {
      browser: metricas.tiempoBrowserMs,
      identificacionLLM: metricas.tiempoIdentificacionLLMMs,
      extraccionLLM: metricas.tiempoExtraccionLLMMs,
      dedup: metricas.tiempoDedupMs,
    },
    llamadasLLM: {
      identificacion: metricas.llamadasLLM.identificacion,
      extraccion: metricas.llamadasLLM.extraccion,
    },
    llm,
  })
  for (const r of resultadosMedios.filter(r => r.problema)) {
    log('⚠️', `${r.medio}: ${r.problema}`)
  }
  // Una sola línea legible por máquina, para el agente local y cualquier otro
  // consumidor que no quiera parsear el log libre.
  console.log(formatearEvento({ tipo: 'resumen', resumen }))

  const exitCode = motivoFallo ? 1 : 0

  // Actualizar fecha de la fuente
  if (!DRY_RUN && (contadores.hechosNuevos > 0 || contadores.coberturasVinculadas > 0) && fuenteId) {
    await prisma.fuente.update({
      where: { id: fuenteId },
      data: { ultimaActualizacion: new Date() }
    })
  }

  await finalizarCorridaPropia(resumen, exitCode)
  return exitCode
}

let fuenteId: string | null = null

/**
 * Recorre los medios. Devuelve el motivo si la corrida hubo que abortarla
 * (browser inutilizable, proveedor LLM caído a mitad de camino), o undefined.
 */
async function recorrerMedios(
  medios: MedioConfig[],
  resultadosMedios: ResultadoMedio[]
): Promise<string | undefined> {
  // Resolver el ejecutable local antes de cualquier otra cosa. Se usa la ruta
  // explícita dentro de node_modules en vez del PATH, para no depender de un
  // binario global de versión desconocida ni de un PATH inyectado.
  try {
    const ruta = resolverEjecutable()
    log('✅', `agent-browser encontrado en ${ruta}`)
  } catch (error) {
    if (error instanceof EjecutableNoEncontradoError) {
      log('❌', error.message)
      return error.message
    }
    throw error
  }

  const versionAB = ab(comandos.version(), 5000)
  if (!versionAB) {
    log('❌', 'agent-browser está instalado pero no responde')
    log('💡', 'Probá: npx agent-browser install')
    return 'agent-browser está instalado pero no responde (probá: npx agent-browser install)'
  }
  log('✅', `agent-browser ${versionAB}`)

  // Pre-warm del daemon (una vez al inicio)
  browserIniciado = true
  if (!prewarmDaemon()) {
    return 'no se pudo iniciar el browser (agent-browser)'
  }

  // Obtener o crear fuente periodística. En dry-run no se crea nada.
  const existente = await prisma.fuente.findFirst({ where: { nombre: 'Medios Periodísticos' } })
  if (existente) {
    fuenteId = existente.id
  } else if (!DRY_RUN) {
    const creada = await prisma.fuente.create({
      data: {
        nombre: 'Medios Periodísticos',
        tipo: 'PERIODISTICA',
        urlBase: 'https://opencode.ai',
        frecuencia: 'diaria',
        confianzaDefault: 'PRELIMINAR',
        activa: true,
      }
    })
    fuenteId = creada.id
    log('📝', 'Fuente "Medios Periodísticos" creada')
  }

  // Cargar mapa de tipos de delito
  const tiposDelito = await prisma.tipoDelito.findMany()
  const ctx: ContextoInsercion = {
    fuenteId: fuenteId ?? 'dry-run',
    tipoPorCodigo: new Map(tiposDelito.map(t => [t.codigoSnic, t])),
  }

  // ── Procesar cada medio ──
  for (let i = 0; i < medios.length; i++) {
    const medio = medios[i]

    const abortar = saludLLM.motivoParaAbortar()
    if (abortar) {
      log('🚨', `Se corta la corrida antes de ${medio.nombre}: ${abortar}`)
      return abortar
    }

    log('', '─'.repeat(60))
    emitirProgreso({ medioIndice: i + 1, medio: medio.nombre, fase: 'navegando' })

    const { noticias: noticiasRaw, duplicadasTempranas, resultado } = await scrapearMedio(medio)
    resultadosMedios.push(resultado)
    contadores.noticiasScrapeadas += noticiasRaw.length
    // Duplicados detectados antes de extraer: cuentan igual que los que
    // descubre deduplicar() después — solo se adelanta CUÁNDO se detectan.
    contadores.duplicados += duplicadasTempranas
    resultado.extraidas = noticiasRaw.length

    emitirProgreso({ fase: 'extrayendo' })
    for (const noticia of noticiasRaw) {
      const motivo = saludLLM.motivoParaAbortar()
      if (motivo) {
        log('🚨', `Se corta la corrida en ${medio.nombre}: ${motivo}`)
        return motivo
      }
      try {
        await procesarNoticia(noticia, ctx)
      } catch (error) {
        // Un error de base en UNA noticia (conexión cortada, una URL que otra
        // corrida insertó un instante antes) ya no tira abajo el resto de los
        // medios del día: antes llegaba hasta main().catch().
        if ((error as { code?: string })?.code === 'P2002') {
          log('⏭️', `URL registrada por otra corrida en paralelo: ${noticia.url.slice(0, 60)}`)
          contadores.duplicados++
        } else {
          log('❌', `Error procesando ${noticia.url.slice(0, 80)}: ${String(error).slice(0, 200)}`)
          contadores.descartados++
        }
      }
      emitirProgreso()
    }
  }

  return undefined
}

/** Cierra el browser de esta corrida si se llegó a abrir. */
function cerrarBrowser() {
  if (!browserIniciado) return
  browserIniciado = false
  ejecutarBrowser(comandos.cerrar(), { timeoutMs: 15000 })
}

// Cancelación desde el panel (el agente manda SIGTERM) o Ctrl+C en la consola:
// se cierra el browser para no dejar un Chrome huérfano en la computadora.
let saliendoPorSenal = false
for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    if (saliendoPorSenal) return
    saliendoPorSenal = true
    log('🛑', `Señal ${senal}: se cierra el browser y se corta la corrida`)
    cerrarBrowser()
    setTimeout(() => process.exit(130), 5000).unref()
    finalizarCorridaPropia(null, 130, true)
      .finally(() => prisma.$disconnect())
      .finally(() => process.exit(130))
  })
}

main()
  .then(codigo => { process.exitCode = codigo })
  .catch(async e => {
    log('❌', 'Error fatal:', e instanceof Error ? { mensaje: e.message, stack: e.stack } : e)
    await finalizarCorridaPropia(null, 1)
    process.exitCode = 1
  })
  .finally(async () => {
    cerrarBrowser()
    await prisma.$disconnect()
  })
