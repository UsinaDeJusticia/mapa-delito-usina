/**
 * Cliente OpenRouter/Ollama para extracción estructurada de noticias policiales.
 * El proveedor y modelo se seleccionan mediante PIPELINE_PERFIL_MODELO:
 *   economico (default) → DeepSeek V3 via OpenRouter
 *   preciso             → Claude Haiku via OpenRouter
 *   local               → Ollama (OLLAMA_MODEL + OLLAMA_BASE_URL)
 */

import OpenAI from 'openai'
import { getConfigActiva } from '@/config/modelos-pipeline'

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

const PROMPT_SISTEMA = `Sos un analista forense de datos para Usina de Justicia, ONG argentina de víctimas de homicidio y femicidio.

OBJETIVO: Extraer datos ÚNICAMENTE de noticias sobre homicidios, femicidios, muertes violentas o tentativas de homicidio.

CRITERIO ÚNICO DE INCLUSIÓN: La noticia debe describir un hecho donde hay UNA O MÁS VÍCTIMAS FALLECIDAS o en ESTADO CRÍTICO con riesgo de vida. Si no hay muertos ni heridos graves, responder con esHechoDelictivo: false.

CAMPO esHechoDelictivo:
- true SOLO si: homicidio doloso, femicidio, muerte en ocasión de robo, homicidio culposo (accidente fatal), tentativa de homicidio con heridos graves
- false si: robo sin lesiones, amenazas, drogas sin muerte, lesiones leves, estadísticas, opinión, política

CAMPO requiereRevision (true si alguna de estas condiciones):
- El número de víctimas no está claro
- La fecha del hecho es ambigua o ausente
- La provincia/localidad no está mencionada explícitamente
- El hecho podría ser accidente y no homicidio

CÓDIGOS SNIC VÁLIDOS (usar SOLO estos):
- 0 = Muerte violenta en investigación (dudoso si doloso o culposo)
- 1 = Homicidio doloso
- 2 = Tentativa de homicidio (heridos de gravedad)
- 3 = Homicidio culposo (tránsito, negligencia)
- 4 = Femicidio / violencia de género con muerte

SESGO EDITORIAL: Los títulos suelen exagerar — "asesinato" puede ser "homicidio culposo", "femicidio" puede ser "muerte en investigación". Priorizar la descripción del cuerpo del artículo sobre el título.

La fecha debe ser del HECHO, no de la publicación.
Ubicación: extraer provincia, ciudad/localidad, barrio y dirección si están disponibles.
confianzaExtraccion: 90+ si todos los datos son claros, 70-89 si faltan algunos, <70 si es ambiguo.

Respondé SOLO con JSON válido, sin texto adicional, sin backticks, sin markdown.`

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

  try {
    const respuesta = await cliente.chat.completions.create({
      model: config.modelo,
      messages: [
        { role: 'system', content: PROMPT_SISTEMA },
        {
          role: 'user',
          content: `Extraé los datos del siguiente texto de noticia policial argentina:\n\n---\n${textoNoticia.slice(0, 3000)}\n---\n\nURL fuente: ${urlFuente}`,
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

    const datos = JSON.parse(jsonLimpio) as HechoExtraido

    // Validar campos mínimos
    if (typeof datos.esHechoDelictivo !== 'boolean') {
      console.error('⚠️ Respuesta IA sin campo esHechoDelictivo')
      return RESPUESTA_FALLBACK
    }

    // Asegurar que la estructura de ubicacion existe
    if (!datos.ubicacion) {
      datos.ubicacion = { provincia: null, ciudad: null, barrio: null, direccion: null }
    }

    // Asegurar confianza numérica
    if (typeof datos.confianzaExtraccion !== 'number') {
      datos.confianzaExtraccion = 50
    }

    return datos

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Error extrayendo datos de ${urlFuente}: ${errorMsg}`)
    return RESPUESTA_FALLBACK
  }
}
