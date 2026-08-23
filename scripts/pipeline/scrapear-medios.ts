/**
 * Pipeline de scraping de medios periodísticos.
 *
 * Flujo completo:
 * 1. agent-browser (CLI) navega secciones policiales de cada medio
 * 2. Extrae URLs y texto de noticias recientes
 * 3. OpenRouter (DeepSeek/Qwen) extrae datos estructurados
 * 4. Deduplicador IA determina si es hecho nuevo o cobertura existente
 * 5. API Georef normaliza ubicaciones
 * 6. Se inserta en Neon con confianza PRELIMINAR
 *
 * Uso:
 *   npx tsx scripts/pipeline/scrapear-medios.ts
 *   npx tsx scripts/pipeline/scrapear-medios.ts --dry-run
 *   npx tsx scripts/pipeline/scrapear-medios.ts --medio=infobae
 */

import { PrismaClient } from '@prisma/client'
import { extraerDatosNoticia } from '../../src/lib/mapa/openrouter'
import { deduplicar, clasificarCobertura, urlYaRegistrada } from '../../src/lib/mapa/deduplicador'
import { crearClienteLLM } from '../../src/lib/mapa/cliente-llm'
import {
  comandos,
  ejecutarBrowser,
  esRefValido,
  extraerRefDeSnapshot,
  resolverEjecutable,
  EjecutableNoEncontradoError,
} from '../../src/lib/pipeline/browser-cmd'
import { esDestinoPermitido } from '../../src/lib/pipeline/url-segura'
import { MEDIOS, type MedioConfig } from './medios-config'
import { obtenerContenidoLLM, formatearUso } from '../../src/lib/pipeline/llamada-llm'
import {
  parsearJsonLLM,
  validarLinksIdentificados,
} from '../../src/lib/pipeline/schemas-llm'

const prisma = new PrismaClient()

// ════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════

const DRY_RUN = process.argv.includes('--dry-run') || process.env.PIPELINE_DRY_RUN === 'true'
const MAX_NOTICIAS = parseInt(process.env.PIPELINE_MAX_NOTICIAS || '20')
const MEDIO_ESPECIFICO = process.argv.find(a => a.startsWith('--medio='))?.split('=')[1]
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
 * tamaños desde workflow_dispatch sin editar código entre corridas.
 */
const SNAPSHOT_MAX_CHARS = Number(process.env.PIPELINE_SNAPSHOT_MAX_CHARS) || 3000

/**
 * Métricas por fase de la corrida, acumuladas a lo largo de todo el
 * pipeline y volcadas al resumen final.
 *
 * Sin esto no se puede comparar contra la línea de base: el diagnóstico del
 * 22/8 (79 min, 66 medios) se armó reconstruyendo tiempos a mano a partir del
 * espaciado de timestamps en los logs. Con estos acumuladores, la próxima
 * corrida deja el desglose ya calculado.
 *
 * Deliberadamente vive solo en este archivo (no en llamada-llm.ts): otro
 * agente está trabajando en paralelo sobre ese módulo.
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
// MEDIOS A SCRAPEAR
// ════════════════════════════════════════════

// MEDIOS y MedioConfig viven en ./medios-config — los comparte el health-check.

// ════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════

function log(emoji: string, msg: string, data?: unknown) {
  const ts = new Date().toLocaleTimeString('es-AR')
  console.log(`${emoji} [${ts}] ${msg}`)
  if (data) console.log('   ', JSON.stringify(data, null, 2))
}

/**
 * Ejecuta agent-browser con argumentos separados y sin shell.
 *
 * Reemplaza al viejo `agentCmd(string)`, que concatenaba el comando y lo pasaba
 * a `execSync`: un `ref` elegido por el LLM a partir del snapshot de un sitio de
 * terceros llegaba a un shell con el entorno completo del proceso. Ahora los
 * comandos se construyen como arrays validados en src/lib/pipeline/browser-cmd.ts
 * y el subproceso recibe un entorno mínimo, sin credenciales.
 *
 * Devuelve stdout o cadena vacía si falló, igual que antes, para no cambiar el
 * manejo de errores de los llamadores.
 *
 * Todas las operaciones de browser del pipeline pasan por acá, así que es el
 * único punto donde hay que medir para tener el tiempo de fase "browser"
 * completo (navegación, snapshots, clicks, waits, getUrl/getTexto...).
 */
function ab(args: readonly string[], timeoutMs: number = 30000): string {
  const inicio = Date.now()
  const r = ejecutarBrowser(args, { timeoutMs })
  metricas.tiempoBrowserMs += Date.now() - inicio
  if (!r.ok && r.error) {
    log('⚠️', `agent-browser ${args[0]}: ${r.error.slice(0, 150)}`)
  }
  return r.salida
}

/**
 * Usa IA (DeepSeek via OpenRouter) para identificar qué refs del snapshot
 * son links a noticias policiales/de seguridad.
 *
 * Esto reemplaza el parseo por regex y funciona en CUALQUIER sitio
 * sin configuración específica.
 */
async function identificarNoticiasConIA(
  snapshot: string,
  medio: string
): Promise<Array<{ ref: string; titulo: string }>> {

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
        {
          role: 'system',
          content: `Sos un analista experto en seguridad y noticias policiales de Argentina. Tu tarea es revisar un snapshot de un sitio web e identificar ÚNICAMENTE los enlaces (links) que correspondan a noticias de crímenes o hechos policiales donde haya una o más personas muertas por causas violentas o dudosas.

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

Máximo 10 resultados, ordenados de más a menos relevante.`
        },
        {
          role: 'user',
          // 30000 y no 3000. Los refs SOLO existen dentro del snapshot, así
          // que el modelo no puede nombrar ningún enlace que caiga después del
          // corte: con 3000 chars de una portada de diario se veía el logo, el
          // menú y las primeras notas, y el techo de 10 resultados nunca se
          // alcanzaba porque el material para alcanzarlo no llegaba. Además, un
          // snapshot cortado a la mitad de un ref es justo la situación en la
          // que el modelo improvisa un ref inválido y se descarta la entrada.
          // Costo: ~6750 tokens de entrada extra por medio, del orden de USD
          // 0,06 al mes al perfil económico. No bajarlo sin medir los
          // prompt_tokens reales que ahora quedan en los logs.
          content: `Snapshot del sitio ${medio}:\n\n${snapshot.slice(0, SNAPSHOT_MAX_CHARS)}`
        }
      ],
      temperature: 0.1,
      max_tokens: 800,
      }),
    })

    // ANTES esto era `content?.trim() || '[]'`: una respuesta vacía del modelo
    // se convertía en silencio en "este medio no tiene noticias", sin un solo
    // log. Un medio entero se perdía sin dejar rastro, y en los logs quedaba
    // indistinguible de "revisé y no había homicidios". Con ~45 medios
    // devolviendo casi todos "0 noticias", esa confusión tapaba el problema.
    if (!resultado.ok) {
      log('⚠️', `Identificación en ${medio}: SIN RESPUESTA USABLE tras ${resultado.intentos} intentos (${resultado.motivo}) — NO es lo mismo que "no hay noticias"`)
      return []
    }

    const parseado = parsearJsonLLM(resultado.contenido)
    if (!parseado.ok) {
      log('⚠️', `Identificación en ${medio}: respuesta no parseable — ${parseado.errores.join('; ')}`)
      return []
    }

    // Valida cada entrada y descarta las que no cumplen, en lugar de aceptar el
    // array crudo. Antes un ref con metacaracteres pasaba directo al comando.
    const { links, descartados } = validarLinksIdentificados(parseado.valor)
    if (descartados.length > 0) {
      // Se distingue "descarté algunas" de "descarté TODAS": lo segundo es un
      // medio entero perdido, y en el resumen de la corrida quedaba
      // indistinguible de "no había homicidios". Fue exactamente el caso de El
      // Independiente La Rioja: 10 identificadas, 10 descartadas, cero rastro.
      if (links.length === 0) {
        log('🚨', `Identificación en ${medio}: SE DESCARTARON LAS ${descartados.length} ENTRADAS — el medio se pierde completo, NO es lo mismo que "no hay noticias"`)
      } else {
        log('⚠️', `Identificación en ${medio}: ${descartados.length} entrada(s) descartada(s) de ${descartados.length + links.length}`)
      }
      for (const d of descartados.slice(0, 5)) log('  ', d)
    }
    return links

  } catch (error) {
    const err = error as { message?: string; status?: number; response?: { data?: unknown } }
    console.error('Error identificación detalle:', err.message, err.status, err.response?.data)
    log('⚠️', `Error en identificación IA: ${err.message ?? String(error)}`)
    return []
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

/**
 * Scrapea un medio usando el Tab Isolation Pattern.
 *
 * Flujo (basado en issue #853 de agent-browser):
 * 1. Pre-warm (solo la primera vez)
 * 2. Navegar a la sección policial en tab 0
 * 3. Snapshot -i para obtener refs de links
 * 4. Para cada link:
 *    - click @ref --new-tab (abre en tab nueva)
 *    - tab 1 (cambiar a la tab de detalle)
 *    - Extraer texto del artículo
 *    - tab close (cerrar tab de detalle)
 *    - tab 0 (volver al listado, refs intactos)
 * 5. Cerrar browser
 */
async function scrapearMedio(
  medio: MedioConfig,
  yaPrewarmed: boolean
): Promise<{ noticias: NoticiaScrapeada[]; duplicadasTempranas: number }> {
  const urlTarget = medio.urlPoliciales || medio.url || ''
  log('📰', `Scrapeando ${medio.nombre} (${urlTarget})`)
  const noticias: NoticiaScrapeada[] = []
  let duplicadasTempranas = 0

  try {
    // 1. Navegar a la sección policial
    ab(comandos.abrir(urlTarget), 30000)
    ab(comandos.esperarCarga(), 20000)

    // 2. Snapshot interactivo para obtener refs de links
    const snapshot = ab(comandos.snapshotInteractivo(), 15000)

    if (!snapshot) {
      log('⚠️', `No se pudo obtener snapshot de ${medio.nombre}`)
      return { noticias: [], duplicadasTempranas }
    }

    // 3. Identificar noticias policiales con IA (funciona en cualquier sitio)
    log('🤖', `Identificando noticias policiales con IA en ${medio.nombre}...`)
    const inicioIdentificacion = Date.now()
    const linksNoticias = await identificarNoticiasConIA(snapshot, medio.nombre)
    metricas.tiempoIdentificacionLLMMs += Date.now() - inicioIdentificacion
    metricas.llamadasLLM.identificacion++

    log('🔗', `${linksNoticias.length} noticias policiales identificadas en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias policiales en ${medio.nombre}`)
      return { noticias: [], duplicadasTempranas }
    }

    log('🔗', `${linksNoticias.length} links de noticias encontrados en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias. Snapshot preview:`)
      log('📝', snapshot.slice(0, 500))
      return { noticias: [], duplicadasTempranas }
    }

    // 4. Visitar cada noticia con Tab Isolation Pattern
    const linksAVisitar = linksNoticias.slice(0, 10)

    for (const link of linksAVisitar) {
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

        // Abrir en tab nueva (tab 0 queda intacta)
        ab(comandos.clickNuevaTab(currentRef))
        await new Promise(r => setTimeout(r, 2000)) // Esperar navegación

        // Cambiar a tab 1 (la del detalle)
        ab(comandos.tab(1))
        // 5000ms, no 10000: con domcontentloaded (ver el comentario en
        // comandos.esperarCarga) la condición se cumple apenas el DOM está
        // armado, mucho antes de lo que tardaba networkidle. El timeout
        // viejo de 10s estaba calibrado para una espera que casi nunca se
        // cumplía sola (37 timeouts en la corrida del 22/8); con
        // domcontentloaded ese presupuesto ya no hace falta.
        ab(comandos.esperarCarga(), 5000)

        // Obtener URL del artículo
        const urlArticulo = ab(comandos.getUrl())

        // ¿Dónde aterrizamos realmente?
        //
        // El paso anterior fue un CLICK sobre un link de la portada del medio,
        // no una navegación a una URL que hayamos validado. El browser sigue
        // adonde apunte ese link, y cualquiera que consiga poner un <a href>
        // en esa portada —una nota patrocinada, un widget de terceros
        // comprometido— elige a qué se conecta nuestro servidor. El destino
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

        // ¿Ya está esta URL en la base?
        //
        // Chequeo movido hacia acá desde deduplicar() (paso 1 de ese flujo,
        // que sigue existiendo — ver el comentario en urlYaRegistrada). En
        // producción el 44% de las llamadas de extracción del LLM (32 de 72
        // en la corrida del 22/8) terminaban descartadas por "URL ya
        // procesada": se pagaba texto + LLM completo para descubrir al final
        // algo que ya sabíamos apenas conocimos la URL. Cortando acá se evita
        // extraer texto Y la llamada de extracción para esos casos.
        if (await urlYaRegistrada(urlArticulo)) {
          log('⏭️', `URL ya procesada (se evita extracción): ${urlArticulo.slice(0, 60)}`)
          duplicadasTempranas++
          ab(comandos.cerrarTab())
          ab(comandos.tab(0))
          continue
        }

        // Obtener título
        const titulo = ab(comandos.getTitulo()) || link.titulo

        // Extraer texto con selectores comunes
        let texto = ''
        const selectoresContenido = [
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
        ]

        for (const selector of selectoresContenido) {
          texto = ab(comandos.getTexto(selector), 5000)
          if (texto && texto.length > 100) break
        }

        // Fallback: snapshot compacto de main
        if (!texto || texto.length < 100) {
          const snapMain = ab(comandos.snapshotSelector('main'), 5000)
          if (snapMain && snapMain.length > 100) {
            texto = snapMain.slice(0, 8000)
          }
        }

        // Cerrar tab de detalle, volver a tab 0
        ab(comandos.cerrarTab())
        await new Promise(r => setTimeout(r, 500))
        ab(comandos.tab(0))
        await new Promise(r => setTimeout(r, 500))

        if (titulo && texto && texto.length > 80) {
          noticias.push({
            titulo: titulo.trim(),
            // 8000 para dejar margen sobre los 6000 que openrouter.ts manda
            // al modelo. Antes eran 5000 acá y 3000 allá: se guardaban 2000
            // chars que nunca llegaban a leerse.
            texto: texto.trim().slice(0, 8000),
            url: urlArticulo || '',
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

      // Rate limiting entre noticias
      await new Promise(r => setTimeout(r, 2000))
    }

    log('📊', `${medio.nombre}: ${noticias.length} noticias extraídas`)

    return { noticias, duplicadasTempranas }

  } catch (error) {
    log('❌', `Error general en ${medio.nombre}: ${String(error).slice(0, 150)}`)
  }

  return { noticias, duplicadasTempranas }
}

// ════════════════════════════════════════════
// GEORREFERENCIACIÓN
// ════════════════════════════════════════════

async function georreferenciar(
  provincia: string | null,
  ciudad: string | null,
): Promise<{ provinciaId: string; latitud: number; longitud: number } | null> {
  if (!provincia) return null

  try {
    const resProv = await fetch(
      `https://apis.datos.gob.ar/georef/api/provincias?nombre=${encodeURIComponent(provincia)}&max=1`
    )
    const dataProv = await resProv.json()
    const prov = dataProv.provincias?.[0]

    if (!prov) return null

    // Si hay ciudad, buscar departamento para mejor precisión
    if (ciudad) {
      const resDep = await fetch(
        `https://apis.datos.gob.ar/georef/api/departamentos?nombre=${encodeURIComponent(ciudad)}&provincia=${prov.id}&max=1`
      )
      const dataDep = await resDep.json()
      const dep = dataDep.departamentos?.[0]

      if (dep?.centroide) {
        return {
          provinciaId: prov.id,
          latitud: dep.centroide.lat,
          longitud: dep.centroide.lon,
        }
      }
    }

    // Fallback: centroide de la provincia
    if (prov.centroide) {
      return {
        provinciaId: prov.id,
        latitud: prov.centroide.lat,
        longitud: prov.centroide.lon,
      }
    }

    return null
  } catch (_e) {
    log('⚠️', `Error georreferenciando ${provincia}/${ciudad}`)
    return null
  }
}

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

async function main() {
  log('🚀', 'Pipeline de Medios Periodísticos')
  log('⚙️', `Modo: ${DRY_RUN ? '🔍 DRY RUN' : '💾 ESCRITURA REAL'}`)
  log('⚙️', `Máximo noticias por medio: ${MAX_NOTICIAS}`)
  log('⚙️', `Confianza mínima: ${CONFIANZA_MINIMA}%`)

  // Resolver el ejecutable local antes de cualquier otra cosa. Se usa la ruta
  // explícita de node_modules/.bin en vez del PATH, para no depender de un
  // binario global de versión desconocida ni de un PATH inyectado.
  try {
    const ruta = resolverEjecutable()
    log('✅', `agent-browser encontrado en ${ruta}`)
  } catch (error) {
    if (error instanceof EjecutableNoEncontradoError) {
      log('❌', error.message)
      process.exit(1)
    }
    throw error
  }

  const versionAB = ab(comandos.version(), 5000)
  if (!versionAB) {
    log('❌', 'agent-browser está instalado pero no responde')
    log('💡', 'Probá: npx agent-browser install')
    process.exit(1)
  }
  log('✅', `agent-browser ${versionAB}`)

  // Pre-warm del daemon (solo una vez al inicio)
  let yaPrewarmed = false
  if (!yaPrewarmed) {
    yaPrewarmed = prewarmDaemon()
    if (!yaPrewarmed) {
      log('❌', 'No se pudo iniciar agent-browser. Saliendo.')
      process.exit(1)
    }
  }

  // Filtrar medios — excluir inactivos (paywall) salvo que se pida uno explícito
  const medios = MEDIO_ESPECIFICO
    ? MEDIOS.filter(m => m.id === MEDIO_ESPECIFICO)
    : MEDIOS.filter(m => m.activo !== false)

  if (medios.length === 0) {
    log('❌', `Medio "${MEDIO_ESPECIFICO}" no encontrado`)
    log('📋', 'Medios disponibles:', MEDIOS.map(m => m.id))
    process.exit(1)
  }

  log('📰', `Medios a scrapear: ${medios.map(m => m.nombre).join(', ')}`)

  // Obtener o crear fuente periodística
  let fuentePeriodistica = await prisma.fuente.findFirst({
    where: { nombre: 'Medios Periodísticos' }
  })

  if (!fuentePeriodistica) {
    fuentePeriodistica = await prisma.fuente.create({
      data: {
        nombre: 'Medios Periodísticos',
        tipo: 'PERIODISTICA',
        urlBase: 'https://openrouter.ai',
        frecuencia: 'diaria',
        confianzaDefault: 'PRELIMINAR',
        activa: true,
      }
    })
    log('📝', 'Fuente "Medios Periodísticos" creada')
  }

  // Cargar mapa de tipos de delito
  const tiposDelito = await prisma.tipoDelito.findMany()
  const tipoPorCodigo = new Map(tiposDelito.map(t => [t.codigoSnic, t]))

  // ── Estadísticas ──
  let totalScrapeadas = 0
  let totalExtraidas = 0
  let totalInsertadas = 0
  let totalVinculadas = 0
  let totalDuplicadas = 0
  let totalDescartadas = 0

  // ── Procesar cada medio ──
  for (const medio of medios) {
    log('', '─'.repeat(60))

    const { noticias: noticiasRaw, duplicadasTempranas } = await scrapearMedio(medio, yaPrewarmed)
    totalScrapeadas += noticiasRaw.length
    // Duplicados detectados antes de extraer (ver el comentario en
    // scrapearMedio): cuentan igual que los que antes descubría deduplicar()
    // después de la extracción — el campo `duplicados` del resumen no cambia
    // de semántica, solo se adelanta CUÁNDO se detectan.
    totalDuplicadas += duplicadasTempranas

    for (const noticia of noticiasRaw) {

      // ── Extracción IA ──
      log('🤖', `Extrayendo datos de: ${noticia.titulo.slice(0, 60)}...`)
      const inicioExtraccion = Date.now()
      const datos = await extraerDatosNoticia(noticia.texto, noticia.url)
      metricas.tiempoExtraccionLLMMs += Date.now() - inicioExtraccion
      metricas.llamadasLLM.extraccion++

      if (!datos.esHechoDelictivo) {
        log('⏭️', `No es hecho delictivo: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      if (datos.confianzaExtraccion < CONFIANZA_MINIMA) {
        log('⏭️', `Confianza baja (${datos.confianzaExtraccion}%): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      if (datos.codigoSnicEstimado !== null &&
          ![0, 1, 2, 3, 4].includes(datos.codigoSnicEstimado)) {
        log('⏭️', `Código SNIC inválido para homicidios: ${datos.codigoSnicEstimado} — "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      totalExtraidas++

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
        totalDuplicadas++
        continue
      }

      // ── Georreferenciación ──
      const provinciaParaGeoref = datos.ubicacion.provincia || noticia.provinciaOrigen || null
      const geo = await georreferenciar(provinciaParaGeoref, datos.ubicacion.ciudad)

      if (!geo) {
        log('⚠️', `No se pudo georreferenciar (${provinciaParaGeoref}): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      // Mapear tipo de delito — sin default, el LLM debe asignar código
      // != null, NO la verdad del valor. El código SNIC 0 ("muerte violenta en
      // investigación") es válido y es falsy en JS, así que con `? :` el lookup
      // nunca corría: caía en el `if (!tipoDelito)` de abajo y descartaba la
      // noticia. La línea 713 ya usaba `!== null` para validar el rango; acá
      // había quedado la comparación laxa.
      const tipoDelito = datos.codigoSnicEstimado != null
        ? tipoPorCodigo.get(String(datos.codigoSnicEstimado))
        : null

      if (!tipoDelito) {
        log('⚠️', `Código SNIC ${datos.codigoSnicEstimado ?? 'null'} no mapeado: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      // Parsear fecha
      let fechaHecho: Date
      try {
        fechaHecho = datos.fecha ? new Date(datos.fecha) : new Date()
        if (isNaN(fechaHecho.getTime())) fechaHecho = new Date()
      } catch (_e) {
        fechaHecho = new Date()
      }

      // ── DRY RUN: solo mostrar ──
      if (DRY_RUN) {
        log('🔍', `[DRY RUN] ${dedup.esNuevo ? 'NUEVO' : 'COBERTURA'}: ${datos.tipoHecho} | SNIC:${datos.codigoSnicEstimado} | ${provinciaParaGeoref} | confianza:${datos.confianzaExtraccion}% | revision:${(datos.requiereRevision || dedup.requiereRevision) ? '⚠️ SI' : 'no'} | ${noticia.url}`)
        if (dedup.esNuevo) totalInsertadas++
        else totalVinculadas++
        continue
      }

      /*
       * MIGRACIÓN REQUERIDA antes de activar requiereRevision en producción:
       *
       * ALTER TABLE hechos_delictivos
       *   ADD COLUMN IF NOT EXISTS requiere_revision BOOLEAN NOT NULL DEFAULT false;
       *
       * CREATE INDEX IF NOT EXISTS idx_hechos_requiere_revision
       *   ON hechos_delictivos (requiere_revision)
       *   WHERE requiere_revision = true;
       */

      // ── INSERCIÓN REAL ──
      if (dedup.esNuevo) {
        // CASO A: Hecho nuevo → HechoDelictivo + primera CoberturaMediatica
        log('🆕', `Hecho NUEVO (${dedup.confianza}%): ${noticia.titulo.slice(0, 50)}`)

        // Buscar o crear ubicación
        let ubicacion = await prisma.ubicacion.findFirst({
          where: { provinciaId: geo.provinciaId, latitud: geo.latitud, longitud: geo.longitud }
        })

        if (!ubicacion) {
          ubicacion = await prisma.ubicacion.create({
            data: {
              provincia: provinciaParaGeoref || 'Desconocida',
              provinciaId: geo.provinciaId,
              departamento: datos.ubicacion.ciudad,
              localidad: datos.ubicacion.barrio,
              direccion: datos.ubicacion.direccion,
              latitud: geo.latitud,
              longitud: geo.longitud,
              esCentroide: !datos.ubicacion.ciudad,
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
              anio: fechaHecho.getFullYear(),
              mes: fechaHecho.getMonth() + 1,
              ubicacionId: ubicacion!.id,
              cantidadVictimas: datos.cantidadVictimas || 1,
              cantidadHechos: 1,
              medioUtilizado: datos.medioUtilizado,
              fuenteId: fuentePeriodistica!.id,
              confianza: 'PRELIMINAR',
              urlFuente: noticia.url,
              esAgregado: false,
              esCasoUsina: false,
              // Dos señales distintas piden revisión, y ninguna reemplaza a
              // la otra: la extracción puede estar segura del hecho pero la
              // deduplicación no pudo confirmar si es nuevo (proveedor de IA
              // caído o respuesta inválida) — o al revés. dedup.requiereRevision
              // es la que faltaba: antes, una falla del deduplicador insertaba
              // el hecho como nuevo sin ninguna marca visible en el panel.
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

        totalInsertadas++

      } else {
        // CASO B: Cobertura de hecho existente → solo CoberturaMediatica
        log('📎', `Cobertura existente (${dedup.razon}): ${noticia.titulo.slice(0, 50)}`)

        const tipoCobertura = clasificarCobertura(noticia.titulo, noticia.texto)

        // La cobertura y la promoción a VERIFICADO van juntas: el conteo es
        // un read-modify-write y dos corridas concurrentes podrían dejar el
        // hecho sin promover pese a superar el umbral.
        const totalCoberturas = await prisma.$transaction(async (tx) => {
          await tx.coberturaMediatica.create({
            data: {
              hechoDelictivoId: dedup.hechoDelictivoId!,
              medio: noticia.medio,
              medioTipo: noticia.medioTipo,
              titulo: noticia.titulo,
              url: noticia.url,
              fechaPublicacion: new Date(),
              resumen: datos.descripcionBreve,
              tipoCobertura: tipoCobertura as 'HECHO_INICIAL' | 'ACTUALIZACION' | 'DETENCION' | 'MARCHA_RECLAMO' | 'PROCESO_JUDICIAL' | 'SENTENCIA' | 'ANIVERSARIO' | 'OPINION_EDITORIAL',
            }
          })

          // Promover a VERIFICADO si 3+ coberturas
          const total = await tx.coberturaMediatica.count({
            where: { hechoDelictivoId: dedup.hechoDelictivoId! }
          })

          if (total >= 3) {
            await tx.hechoDelictivo.update({
              where: { id: dedup.hechoDelictivoId! },
              data: { confianza: 'VERIFICADO' }
            })
          }

          return total
        })

        if (totalCoberturas >= 3) {
          log('✅', `Hecho promovido a VERIFICADO (${totalCoberturas} coberturas)`)
        }

        totalVinculadas++
      }

      // Rate limiting entre llamadas a OpenRouter
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Cerrar browser al final
  ab(comandos.cerrar())

  // ── Resumen final ──
  log('', '═'.repeat(60))
  log('🎉', 'Pipeline completado')
  log('📊', 'Resumen:', {
    noticiasScrapeadas: totalScrapeadas,
    hechosExtraidos: totalExtraidas,
    hechosNuevos: totalInsertadas,
    coberturasVinculadas: totalVinculadas,
    duplicados: totalDuplicadas,
    descartados: totalDescartadas,
    modo: DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN',
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
  })

  // Actualizar fecha de la fuente
  if (!DRY_RUN && (totalInsertadas > 0 || totalVinculadas > 0)) {
    await prisma.fuente.update({
      where: { id: fuentePeriodistica!.id },
      data: { ultimaActualizacion: new Date() }
    })
  }
}

main()
  .catch(e => {
    log('❌', 'Error fatal:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())