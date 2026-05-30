/**
 * Cliente OpenRouter/Ollama para extracción estructurada de noticias policiales.
 * El proveedor y modelo se seleccionan mediante PIPELINE_PERFIL_MODELO:
 *   economico (default) → DeepSeek V3 via OpenRouter
 *   preciso             → Claude Haiku via OpenRouter
 *   local               → Ollama (OLLAMA_MODEL + OLLAMA_BASE_URL)
 */

import OpenAI from 'openai'
import { getConfigActiva } from '@/config/modelos-pipeline'
import { prisma } from '@/lib/mapa/queries'

// Caché de ejemplos few-shot: se invalida cada 5 minutos
let fewShotCache: { ejemplos: Array<{ resumen: string; clasificacion: string }>; ts: number } | null = null
const FEW_SHOT_TTL_MS = 5 * 60 * 1000

async function getFewShotEjemplos() {
  const ahora = Date.now()
  if (fewShotCache && ahora - fewShotCache.ts < FEW_SHOT_TTL_MS) {
    return fewShotCache.ejemplos
  }
  const ejemplos = await prisma.$queryRaw<Array<{
    resumen: string
    clasificacion: string
  }>>`
    SELECT
      cm.resumen,
      rp.clasificacion_humana AS clasificacion
    FROM revisiones_pipeline rp
    JOIN hechos_delictivos hd ON rp.hecho_id = hd.id
    JOIN coberturas_mediaticas cm ON cm.hecho_delictivo_id = hd.id
    WHERE rp.clasificacion_humana != 'no_es_homicidio'
      AND cm.resumen IS NOT NULL
      AND LENGTH(cm.resumen) > 30
    ORDER BY rp.revisado_at DESC
    LIMIT 3
  `.catch(() => [])
  fewShotCache = { ejemplos, ts: ahora }
  return ejemplos
}

// ════════════════════════════════════════════
// TIPO DE DATO EXTRAÍDO
// ════════════════════════════════════════════

export interface HechoExtraido {
  esHechoDelictivo: boolean
  tipoHecho: string | null
  codigoSnicEstimado: number | null
  ubicacion: {
    provincia: string | null
    ciudad: string | null
    barrio: string | null
    direccion: string | null
  }
  fecha: string | null
  cantidadVictimas: number | null
  medioUtilizado: string | null
  descripcionBreve: string | null
  confianzaExtraccion: number
  requiereRevision?: boolean
}

// ════════════════════════════════════════════
// PROMPT DEL SISTEMA
// ════════════════════════════════════════════

const PROMPT_SISTEMA = `Sos un analista forense de datos para Usina de Justicia, ONG argentina de víctimas de homicidio y femicidio. Tu objetivo es procesar noticias policiales y estructurar la información de forma estricta.

CRITERIO DE INCLUSIÓN:
- La noticia debe describir un hecho donde hay UNA O MÁS VÍCTIMAS FALLECIDAS o en ESTADO CRÍTICO/RESERVADO con riesgo inminente de vida.
- Si no hay muertos ni heridos graves, seteá "esHechoDelictivo": false y completá el resto de los campos en null o vacíos.

CÓDIGOS SNIC REGLAMENTARIOS:
Asigná obligatoriamente uno de estos códigos según el hecho principal:
- 1 = Homicidio doloso (incluye muertes en ocasión de robo, sicariato, linchamientos).
- 2 = Homicidio doloso en grado de tentativa (heridos graves por ataques letales).
- 3 = Homicidio culposo (accidentes de tránsito fatales, negligencia médica, accidentes laborales).
- 4 = Femicidio / Transfemicidio (violencia de género con resultado de muerte).
- 0 = Muerte violenta de causa dudosa / En investigación (cuerpos hallados sin causa clara aún).

LÓGICA DE FLEXIBILIDAD (CRÍTICO PARA CONFIANZA):
1. Fecha del hecho: Buscá expresiones temporales ("ayer", "esta madrugada"). Si el texto no permite calcular el día exacto, usá la fecha actual de la nota/sistema. NO penalices la confianza por esto.
2. Ubicación: Si no figura la calle exacta, geolocalizá por la Localidad y Provincia descritas.
3. Confianza de Extracción: Seteá un valor de 85 a 100 si está confirmado el hecho violento y la provincia/localidad. Solo bajá de 85 si la noticia es tan ambigua que no se sabe si ocurrió en Argentina o si el hecho es real.

SESGO EDITORIAL: Los títulos suelen exagerar — "asesinato" puede ser "homicidio culposo" según el cuerpo del texto. Priorizá la descripción de los hechos sobre el titular.

FORMATO DE SALIDA:
Respondé EXCLUSIVAMENTE con un objeto JSON válido, sin backticks, sin texto introductorio ni de cierre. Respetá estrictamente esta estructura:

{
  "esHechoDelictivo": true,
  "snic_codigo": 1,
  "provincia": "Nombre de la provincia",
  "localidad": "Nombre de la localidad o ciudad",
  "barrio_o_direccion": "Calle, cruce o barrio si figura, sino null",
  "fecha_hecho": "YYYY-MM-DD",
  "cantidad_victimas": 1,
  "resumen_hecho": "Breve descripción objetiva de los hechos en un párrafo",
  "requiereRevision": false,
  "confianzaExtraccion": 90
}`

// ════════════════════════════════════════════
// TIPOS INTERNOS Y MAPEO
// ════════════════════════════════════════════

// Estructura que devuelve el LLM (nuevo formato)
interface LLMRespuesta {
  esHechoDelictivo: boolean
  snic_codigo: number | null
  provincia: string | null
  localidad: string | null
  barrio_o_direccion: string | null
  fecha_hecho: string | null
  cantidad_victimas: number | null
  resumen_hecho: string | null
  requiereRevision: boolean
  confianzaExtraccion: number
}

const SNIC_DESCRIPCION: Record<number, string> = {
  0: 'Muerte violenta en investigación',
  1: 'Homicidio doloso',
  2: 'Tentativa de homicidio',
  3: 'Homicidio culposo',
  4: 'Femicidio',
}

function mapearRespuesta(resp: LLMRespuesta): HechoExtraido {
  return {
    esHechoDelictivo: resp.esHechoDelictivo,
    tipoHecho: resp.snic_codigo != null ? (SNIC_DESCRIPCION[resp.snic_codigo] ?? null) : null,
    codigoSnicEstimado: resp.snic_codigo ?? null,
    ubicacion: {
      provincia: resp.provincia ?? null,
      ciudad: resp.localidad ?? null,
      barrio: resp.barrio_o_direccion ?? null,
      direccion: null,
    },
    fecha: resp.fecha_hecho ?? null,
    cantidadVictimas: resp.cantidad_victimas ?? null,
    medioUtilizado: null,
    descripcionBreve: resp.resumen_hecho ?? null,
    confianzaExtraccion: typeof resp.confianzaExtraccion === 'number' ? resp.confianzaExtraccion : 50,
    requiereRevision: resp.requiereRevision ?? false,
  }
}

// ════════════════════════════════════════════
// RESPUESTA POR DEFECTO (cuando falla)
// ════════════════════════════════════════════

const RESPUESTA_FALLBACK: HechoExtraido = {
  esHechoDelictivo: false,
  tipoHecho: null,
  codigoSnicEstimado: null,
  ubicacion: { provincia: null, ciudad: null, barrio: null, direccion: null },
  fecha: null,
  cantidadVictimas: null,
  medioUtilizado: null,
  descripcionBreve: null,
  confianzaExtraccion: 0,
  requiereRevision: false,
}

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

/**
 * Extrae datos estructurados de una noticia policial.
 *
 * @param textoNoticia - El texto completo de la noticia (máx 3000 chars)
 * @param urlFuente - URL de la noticia para contexto
 * @returns Datos estructurados del hecho delictivo
 */
export async function extraerDatosNoticia(
  textoNoticia: string,
  urlFuente: string,
): Promise<HechoExtraido> {
  const config = getConfigActiva()
  console.log(`🤖 ${config.descripcion}`)

  // Validar API key para proveedores remotos
  if (config.proveedor === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.error('❌ OPENROUTER_API_KEY no configurada en .env')
    return RESPUESTA_FALLBACK
  }

  const apiKey = config.proveedor === 'ollama'
    ? 'ollama'
    : process.env.OPENROUTER_API_KEY || ''

  // Ollama usa /v1 como sufijo para compatibilidad OpenAI
  const baseURL = config.proveedor === 'ollama'
    ? `${config.baseUrl}/v1`
    : config.baseUrl

  const cliente = new OpenAI({
    baseURL,
    apiKey,
    defaultHeaders: config.proveedor === 'openrouter' ? {
      'HTTP-Referer': 'https://usinadejusticia.org.ar',
      'X-Title': 'Mapa Nacional del Delito - Usina de Justicia',
    } : {},
  })

  const ejemplos = await getFewShotEjemplos()

  const fewShotMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const ej of ejemplos) {
    fewShotMessages.push({
      role: 'user',
      content: `Extraé los datos del siguiente texto:\n---\n${ej.resumen}\n---`,
    })
    fewShotMessages.push({
      role: 'assistant',
      content: JSON.stringify({ esHechoDelictivo: true, confianzaExtraccion: 90 }),
    })
  }

  try {
    const respuesta = await cliente.chat.completions.create({
      model: config.modelo,
      messages: [
        { role: 'system', content: PROMPT_SISTEMA },
        ...fewShotMessages,
        {
          role: 'user',
          content: `Fecha actual de procesamiento: ${new Date().toISOString().slice(0, 10)}\nURL fuente: ${urlFuente}\n\nExtraé los datos del siguiente texto de noticia policial argentina siguiendo el formato JSON requerido:\n---\n${textoNoticia.slice(0, 3000)}\n---`,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    })

    const contenido = respuesta.choices[0]?.message?.content?.trim() || ''

    if (!contenido) {
      console.error('⚠️ Modelo devolvió respuesta vacía')
      return RESPUESTA_FALLBACK
    }

    // Limpiar posibles backticks o markdown
    const jsonLimpio = contenido
      .replace(/^```json\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim()

    const raw = JSON.parse(jsonLimpio) as LLMRespuesta

    // Validar campo mínimo
    if (typeof raw.esHechoDelictivo !== 'boolean') {
      console.error('⚠️ Respuesta IA sin campo esHechoDelictivo')
      return RESPUESTA_FALLBACK
    }

    return mapearRespuesta(raw)

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Error extrayendo datos de ${urlFuente}: ${errorMsg}`)
    return RESPUESTA_FALLBACK
  }
}
