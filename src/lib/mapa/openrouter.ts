/**
 * Cliente OpenRouter para extracción estructurada de noticias policiales.
 * Usa la compatibilidad con OpenAI SDK para llamar modelos económicos
 * (DeepSeek V3, Qwen) a través de OpenRouter.
 *
 * Costo estimado: < $0.50 USD/mes para 100 noticias/día.
 */

import OpenAI from 'openai'

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || '',
  defaultHeaders: {
    'HTTP-Referer': 'https://usinadejusticia.org.ar',
    'X-Title': 'Mapa Nacional del Delito - Usina de Justicia',
  },
})

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
}

// ════════════════════════════════════════════
// PROMPT DEL SISTEMA
// ════════════════════════════════════════════

const PROMPT_SISTEMA = `Sos un analista de datos criminales argentino. Tu trabajo es extraer información estructurada de noticias policiales.

REGLAS ESTRICTAS:
1. Solo extraer hechos delictivos CONCRETOS (homicidios, robos, asaltos, femicidios, etc.)
2. NO extraer opiniones, editoriales, estadísticas generales ni políticas de seguridad
3. Si la noticia no describe un hecho delictivo concreto, responder con esHechoDelictivo: false
4. La fecha debe ser del HECHO, no de la publicación de la noticia
5. El codigoSnicEstimado debe mapear al catálogo SNIC:
   1=Homicidio doloso, 2=Tentativa homicide, 5=Lesiones dolosas,
   10=Violación, 13=Amenazas, 15=Robo, 16=Tentativa de robo,
   17=Robo con lesiones/muerte, 19=Hurto, 28=Estupefacientes
6. confianzaExtraccion: 90+ si todos los datos son claros, 70-89 si faltan algunos, <70 si es ambiguo
7. Si la noticia menciona múltiples hechos, extraer solo el PRINCIPAL
8. Ubicación: extraer provincia, ciudad/localidad, barrio y dirección si están disponibles

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
  const modelo = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3-0324'

  // Verificar que hay API key
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('❌ OPENROUTER_API_KEY no configurada en .env')
    return RESPUESTA_FALLBACK
  }

  try {
    const respuesta = await openrouter.chat.completions.create({
      model: modelo,
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
      console.error('⚠️ OpenRouter devolvió respuesta vacía')
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
