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

import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
import { extraerDatosNoticia } from '../../src/lib/mapa/openrouter'
import { deduplicar, clasificarCobertura } from '../../src/lib/mapa/deduplicador'

const prisma = new PrismaClient()

// ════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════

const DRY_RUN = process.argv.includes('--dry-run') || process.env.PIPELINE_DRY_RUN === 'true'
const MAX_NOTICIAS = parseInt(process.env.PIPELINE_MAX_NOTICIAS || '20')
const MEDIO_ESPECIFICO = process.argv.find(a => a.startsWith('--medio='))?.split('=')[1]
const CONFIANZA_MINIMA = 75

// ════════════════════════════════════════════
// TIPOS
// ════════════════════════════════════════════

interface MedioConfig {
  id: string
  nombre: string
  url: string
  tipo: 'provincial' | 'nacional'
  provincia?: string
}

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

const MEDIOS: MedioConfig[] = [
  // ── PROVINCIALES ──
  { id: 'rosario3',    nombre: 'Rosario3',               url: 'https://www.rosario3.com/policiales/',                  tipo: 'provincial', provincia: 'Santa Fe' },
  { id: 'eldia',       nombre: 'El Día (La Plata)',       url: 'https://www.eldia.com/seccion/policiales/',             tipo: 'provincial', provincia: 'Buenos Aires' },
  { id: 'lavoz',       nombre: 'La Voz del Interior',     url: 'https://www.lavoz.com.ar/sucesos/',                     tipo: 'provincial', provincia: 'Córdoba' },
  { id: 'ellitoral',   nombre: 'El Litoral (Santa Fe)',  url: 'https://www.ellitoral.com/sucesos',                     tipo: 'provincial', provincia: 'Santa Fe' },
  { id: 'lmneuquen',   nombre: 'LM Neuquén',              url: 'https://www.lmneuquen.com/policiales/',                 tipo: 'provincial', provincia: 'Neuquén' },
  { id: 'norte',       nombre: 'Diario Norte (Chaco)',    url: 'https://www.diarionorte.com/seccion/policiales/',       tipo: 'provincial', provincia: 'Chaco' },
  { id: 'eltribuno',   nombre: 'El Tribuno (Salta)',      url: 'https://www.eltribuno.com/salta/policiales',            tipo: 'provincial', provincia: 'Salta' },

  // ── NACIONALES ──
  { id: 'infobae',     nombre: 'Infobae',                 url: 'https://www.infobae.com/sociedad/policiales/',          tipo: 'nacional' },
  { id: 'clarin',      nombre: 'Clarín',                  url: 'https://www.clarin.com/policiales/',                    tipo: 'nacional' },
  { id: 'lanacion',    nombre: 'LA NACION',               url: 'https://www.lanacion.com.ar/seguridad/',                tipo: 'nacional' },
]

// ════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════

function log(emoji: string, msg: string, data?: unknown) {
  const ts = new Date().toLocaleTimeString('es-AR')
  console.log(`${emoji} [${ts}] ${msg}`)
  if (data) console.log('   ', JSON.stringify(data, null, 2))
}

/**
 * Ejecuta un comando de agent-browser CLI y devuelve el output.
 */
function agentCmd(comando: string, timeoutMs: number = 30000): string {
  try {
    const resultado = execSync(`agent-browser ${comando}`, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return resultado.trim()
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
    if (err.killed) {
      log('⚠️', `Timeout: agent-browser ${comando.slice(0, 60)}...`)
    } else if (err.stderr) {
      log('⚠️', `Error agent-browser: ${err.stderr.slice(0, 150)}`)
    }
    return ''
  }
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

  const openrouter = new (await import('openai')).default({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY || '',
    defaultHeaders: {
      'HTTP-Referer': 'https://usinadejusticia.org.ar',
      'X-Title': 'Mapa del Delito - Identificador',
    },
  })

  const modelo = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324'

  try {
    const respuesta = await openrouter.chat.completions.create({
      model: modelo,
      messages: [
        {
          role: 'system',
          content: `Sos un analista que identifica noticias policiales en snapshots de sitios web argentinos.

Te voy a pasar el snapshot de accesibilidad de un sitio de noticias. Cada elemento tiene un ref (ej: e123).
Tu trabajo es identificar SOLO los links que son noticias sobre hechos delictivos concretos:
homicidios, robos, asaltos, femicidios, tiroteos, secuestros, detenciones, crímenes, etc.

NO incluir: política, deportes, economía, espectáculos, opinión, clima, publicidades.

Respondé SOLO con JSON array. Si no hay noticias policiales, respondé [].
Formato: [{"ref": "e123", "titulo": "Texto del link"}]
Máximo 10 resultados.`
        },
        {
          role: 'user',
          content: `Snapshot del sitio ${medio}:\n\n${snapshot.slice(0, 3000)}`
        }
      ],
      temperature: 0.1,
      max_tokens: 800,
    })

    const contenido = respuesta.choices[0]?.message?.content?.trim() || '[]'
    const jsonLimpio = contenido
      .replace(/^```json\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim()

    const resultado = JSON.parse(jsonLimpio)
    return Array.isArray(resultado) ? resultado : []

  } catch (error) {
    log('⚠️', `Error en identificación IA: ${String(error).slice(0, 100)}`)
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
  const result = agentCmd('open about:blank', 90000) // 90s para cold-start
  if (result === '') {
    // Puede devolver vacío pero funcionar igual, verificar con get url
    const url = agentCmd('get url', 5000)
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
async function scrapearMedio(medio: MedioConfig, yaPrewarmed: boolean): Promise<NoticiaScrapeada[]> {
  log('📰', `Scrapeando ${medio.nombre} (${medio.url})`)
  const noticias: NoticiaScrapeada[] = []

  try {
    // 1. Navegar a la sección policial
    agentCmd(`open "${medio.url}"`, 30000)
    agentCmd('wait --load networkidle', 20000)

    // 2. Snapshot interactivo para obtener refs de links
    const snapshot = agentCmd('snapshot -i -c', 15000)

    if (!snapshot) {
      log('⚠️', `No se pudo obtener snapshot de ${medio.nombre}`)
      return []
    }

    // 3. Identificar noticias policiales con IA (funciona en cualquier sitio)
    log('🤖', `Identificando noticias policiales con IA en ${medio.nombre}...`)
    const linksNoticias = await identificarNoticiasConIA(snapshot, medio.nombre)

    log('🔗', `${linksNoticias.length} noticias policiales identificadas en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias policiales en ${medio.nombre}`)
      return []
    }

    log('🔗', `${linksNoticias.length} links de noticias encontrados en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias. Snapshot preview:`)
      log('📝', snapshot.slice(0, 500))
      return []
    }

    // 4. Visitar cada noticia con Tab Isolation Pattern
    const linksAVisitar = linksNoticias.slice(0, 10)

    for (const link of linksAVisitar) {
      try {
        // Re-snapshot y buscar ref fresco por título
        const freshSnapshot = agentCmd('snapshot -i -c', 10000)
        const escapedTitulo = link.titulo.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const freshMatch = freshSnapshot.match(new RegExp(`"${escapedTitulo}.*?\\[ref=(e\\d+)\\]`))
        const currentRef = freshMatch ? freshMatch[1] : link.ref

        // Abrir en tab nueva (tab 0 queda intacta)
        agentCmd(`click @${currentRef} --new-tab`)
        await new Promise(r => setTimeout(r, 2000)) // Esperar navegación

        // Cambiar a tab 1 (la del detalle)
        agentCmd('tab 1')
        agentCmd('wait --load networkidle', 10000)

        // Obtener URL del artículo
        const urlArticulo = agentCmd('get url')

        // Obtener título
        const titulo = agentCmd('get title') || link.titulo

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
          texto = agentCmd(`get text "${selector}"`, 5000)
          if (texto && texto.length > 100) break
        }

        // Fallback: snapshot compacto de main
        if (!texto || texto.length < 100) {
          const snapMain = agentCmd('snapshot -s "main" -c', 5000)
          if (snapMain && snapMain.length > 100) {
            texto = snapMain.slice(0, 5000)
          }
        }

        // Cerrar tab de detalle, volver a tab 0
        agentCmd('tab close')
        await new Promise(r => setTimeout(r, 500))
        agentCmd('tab 0')
        await new Promise(r => setTimeout(r, 500))

        if (titulo && texto && texto.length > 80) {
          noticias.push({
            titulo: titulo.trim(),
            texto: texto.trim().slice(0, 5000),
            url: urlArticulo || '',
            medio: medio.nombre,
            medioTipo: medio.tipo,
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
          agentCmd('tab close')
          agentCmd('tab 0')
        } catch (_e2) { /* ignorar */ }
      }

      // Rate limiting entre noticias
      await new Promise(r => setTimeout(r, 2000))
    }

    log('📊', `${medio.nombre}: ${noticias.length} noticias extraídas`)

    // Filtrar noticias que parecen ser delictivas antes de enviar a OpenRouter
    const noticiasRelevantes = noticias.filter(n => {
      const textoLower = (n.titulo + ' ' + n.texto.slice(0, 200)).toLowerCase()
      const palabrasClave = [
        'matar', 'mató', 'asesi', 'homicid', 'femicid',
        'robo', 'robó', 'robaron', 'asalt', 'baleado', 'balearon',
        'apuñal', 'puñal', 'arma', 'disparo', 'tirote',
        'detenid', 'detención', 'preso', 'cárcel',
        'crimen', 'criminal', 'delito', 'denuncia',
        'víctima', 'muerto', 'cadáver', 'cuerpo',
        'policía', 'policial', 'fiscal', 'juez',
        'secuestr', 'violación', 'abuso', 'golpe',
        'narco', 'droga', 'estupefaciente',
        'inseguridad', 'salidera', 'entradera', 'motochorro',
      ]
      return palabrasClave.some(p => textoLower.includes(p))
    })

    if (noticiasRelevantes.length < noticias.length) {
      log('🔍', `Filtrado: ${noticiasRelevantes.length}/${noticias.length} noticias parecen delictivas`)
    }

    return noticiasRelevantes

  } catch (error) {
    log('❌', `Error general en ${medio.nombre}: ${String(error).slice(0, 150)}`)
  }

  return noticias
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

  // Verificar que agent-browser está instalado
  const versionAB = agentCmd('--version', 5000)
  if (!versionAB) {
    log('❌', 'agent-browser no está instalado o no responde')
    log('💡', 'Instalar con: npm install -g agent-browser && agent-browser install')
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

  // Filtrar medios
  const medios = MEDIO_ESPECIFICO
    ? MEDIOS.filter(m => m.id === MEDIO_ESPECIFICO)
    : MEDIOS

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

    const noticias = await scrapearMedio(medio, yaPrewarmed)
    totalScrapeadas += noticias.length

    for (const noticia of noticias) {

      // ── Extracción IA ──
      log('🤖', `Extrayendo datos de: ${noticia.titulo.slice(0, 60)}...`)
      const datos = await extraerDatosNoticia(noticia.texto, noticia.url)

      if (!datos.esHechoDelictivo) {
        log('⏭️', `No es hecho delictivo`)
        totalDescartadas++
        continue
      }

      if (datos.confianzaExtraccion < CONFIANZA_MINIMA) {
        log('⏭️', `Confianza baja (${datos.confianzaExtraccion}%)`)
        totalDescartadas++
        continue
      }

      totalExtraidas++

      // ── Deduplicación inteligente ──
      const dedup = await deduplicar({
        tipoHecho: datos.tipoHecho || '',
        codigoSnicEstimado: datos.codigoSnicEstimado ? String(datos.codigoSnicEstimado) : '15',
        ubicacion: datos.ubicacion,
        fecha: datos.fecha,
        titulo: noticia.titulo,
        resumen: datos.descripcionBreve,
        medio: noticia.medio,
        medioTipo: noticia.medioTipo,
        url: noticia.url,
      })

      if (dedup.urlDuplicada) {
        log('⏭️', `URL ya procesada: ${noticia.url.slice(0, 50)}`)
        totalDuplicadas++
        continue
      }

      // ── Georreferenciación ──
      const provinciaParaGeoref = datos.ubicacion.provincia || noticia.provinciaOrigen || null
      const geo = await georreferenciar(provinciaParaGeoref, datos.ubicacion.ciudad)

      if (!geo) {
        log('⚠️', `No se pudo georreferenciar: ${provinciaParaGeoref}`)
        totalDescartadas++
        continue
      }

      // Mapear tipo de delito
      const tipoDelito = datos.codigoSnicEstimado
        ? tipoPorCodigo.get(String(datos.codigoSnicEstimado))
        : tipoPorCodigo.get('15') // Default: Robo

      if (!tipoDelito) {
        log('⚠️', `Código SNIC ${datos.codigoSnicEstimado} no mapeado`)
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
        log('🔍', `[DRY RUN] ${dedup.esNuevo ? 'NUEVO' : 'COBERTURA'}: ${datos.tipoHecho} en ${provinciaParaGeoref} (${dedup.razon})`)
        if (dedup.esNuevo) totalInsertadas++
        else totalVinculadas++
        continue
      }

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

        const hecho = await prisma.hechoDelictivo.create({
          data: {
            tipoDelitoId: tipoDelito.id,
            fechaHecho: fechaHecho,
            anio: fechaHecho.getFullYear(),
            mes: fechaHecho.getMonth() + 1,
            ubicacionId: ubicacion.id,
            cantidadVictimas: datos.cantidadVictimas || 1,
            cantidadHechos: 1,
            medioUtilizado: datos.medioUtilizado,
            fuenteId: fuentePeriodistica!.id,
            confianza: 'PRELIMINAR',
            urlFuente: noticia.url,
            esAgregado: false,
            esCasoUsina: false,
          }
        })

        await prisma.coberturaMediatica.create({
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

        totalInsertadas++

      } else {
        // CASO B: Cobertura de hecho existente → solo CoberturaMediatica
        log('📎', `Cobertura existente (${dedup.razon}): ${noticia.titulo.slice(0, 50)}`)

        const tipoCobertura = clasificarCobertura(noticia.titulo, noticia.texto)

        await prisma.coberturaMediatica.create({
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
        const totalCoberturas = await prisma.coberturaMediatica.count({
          where: { hechoDelictivoId: dedup.hechoDelictivoId! }
        })

        if (totalCoberturas >= 3) {
          await prisma.hechoDelictivo.update({
            where: { id: dedup.hechoDelictivoId! },
            data: { confianza: 'VERIFICADO' }
          })
          log('✅', `Hecho promovido a VERIFICADO (${totalCoberturas} coberturas)`)
        }

        totalVinculadas++
      }

      // Rate limiting entre llamadas a OpenRouter
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Cerrar browser al final
  agentCmd('close')

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