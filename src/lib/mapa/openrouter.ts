/**
 * Cliente OpenRouter/Ollama para extracción estructurada de noticias policiales.
 * El proveedor y modelo se seleccionan mediante PIPELINE_PERFIL_MODELO:
 *   economico (default) → DeepSeek V3 via OpenRouter
 *   preciso             → Claude Haiku via OpenRouter
 *   local               → Ollama (OLLAMA_MODEL + OLLAMA_BASE_URL)
 */

import { getConfigActiva } from '@/config/modelos-pipeline'
import { crearClienteLLM, credencialFaltante } from '@/lib/mapa/cliente-llm'
import {
  parsearJsonLLM,
  validarExtraccion,
  type ExtraccionValidada,
} from '@/lib/pipeline/schemas-llm'
import { prisma } from '@/lib/mapa/queries'
import { efectoDeClasificacion } from '@/lib/mapa/clasificacion-humana'
import { obtenerContenidoLLM, formatearUso } from '@/lib/pipeline/llamada-llm'

// Caché de ejemplos few-shot: se invalida cada 5 minutos
let fewShotCache: { ejemplos: Array<{ resumen: string; clasificacion: string }>; ts: number } | null = null
const FEW_SHOT_TTL_MS = 5 * 60 * 1000

/**
 * Últimos casos revisados por humanos, para usar como ejemplos few-shot.
 *
 * Tres problemas que tenía la query anterior, todos en la misma consulta:
 *
 * 1. STALENESS: revisiones_pipeline permite varias filas por hecho_id
 *    (correcciones sucesivas — ver /admin/revisiones, "Corregir"). Sin
 *    agrupar por hecho, una clasificación ya superada podía colarse en el
 *    resultado junto con su corrección, o incluso en su lugar. El
 *    DISTINCT ON (hd.id) + ORDER BY hd.id, revisado_at DESC se queda con la
 *    ÚLTIMA clasificación de cada hecho, nunca una vieja.
 *
 * 2. FANOUT: el JOIN contra coberturas_mediaticas sin acotar traía una fila
 *    por cada cobertura del hecho. Un hecho con varias notas podía ocupar
 *    varios de los 3 lugares del LIMIT, dejando afuera a otros hechos por
 *    completo. El JOIN LATERAL elige una sola cobertura por hecho (la más
 *    reciente que tenga resumen usable), igual que hace route.ts para
 *    "pendientes".
 *
 * 3. SIN EJEMPLOS NEGATIVOS: se excluía 'no_es_homicidio' del todo, así que
 *    el modelo nunca veía un caso real de "esto parecía un homicidio pero no
 *    lo era". Ahora se incluye — construirEjemplosFewShot() lo traduce al
 *    esHechoDelictivo:false que espera el prompt.
 *
 * Además prioriza usar_como_ejemplo=true (columna que existía en el schema
 * desde el principio pero que hasta ahora nada leía ni escribía): un
 * revisor puede curar a mano cuáles casos son los ejemplos más claros,
 * aunque no sean los más recientes. No hay UI todavía para marcarla —
 * se setea a mano en la base mientras tanto.
 *
 * Verificado contra Postgres real con datos sintéticos que reproducen los
 * tres problemas (no solo por inspección del SQL).
 */
async function getFewShotEjemplos() {
  const ahora = Date.now()
  if (fewShotCache && ahora - fewShotCache.ts < FEW_SHOT_TTL_MS) {
    return fewShotCache.ejemplos
  }
  const ejemplos = await prisma.$queryRaw<Array<{
    resumen: string
    clasificacion: string
  }>>`
    SELECT resumen, clasificacion FROM (
      SELECT DISTINCT ON (hd.id)
        cm.resumen,
        rp.clasificacion_humana AS clasificacion,
        rp.revisado_at,
        rp.usar_como_ejemplo
      FROM revisiones_pipeline rp
      JOIN hechos_delictivos hd ON rp.hecho_id = hd.id
      JOIN LATERAL (
        SELECT resumen
        FROM coberturas_mediaticas
        WHERE hecho_delictivo_id = hd.id
          AND resumen IS NOT NULL
          AND LENGTH(resumen) > 30
        ORDER BY created_at DESC
        LIMIT 1
      ) cm ON true
      ORDER BY hd.id, rp.revisado_at DESC
    ) ultimas
    ORDER BY usar_como_ejemplo DESC, revisado_at DESC
    LIMIT 3
  `.catch(() => [])
  fewShotCache = { ejemplos, ts: ahora }
  return ejemplos
}

/**
 * Traduce los casos revisados a los pares user/assistant que se inyectan
 * antes de la noticia real.
 *
 * ANTES el mensaje 'assistant' era un JSON fijo — {esHechoDelictivo: true,
 * confianzaExtraccion: 90} — igual para los 3 ejemplos sin importar qué
 * clasificación hubiera elegido el humano. El campo `clasificacion` se leía
 * de la base y no se usaba para nada: el modelo nunca veía la diferencia
 * entre un femicidio, un homicidio narco o un caso descartado. Esta función
 * es pura y separada de extraerDatosNoticia() para poder testearla sin
 * tocar la base ni el cliente LLM.
 */
/**
 * Cuánto de cada resumen se inyecta como ejemplo.
 *
 * Sin tope, tres ejemplos podían aportar ~4000 tokens de contexto —el validador
 * tolera resúmenes de hasta 4000 chars cada uno— y diluir la instrucción de
 * formato ("respondé solo JSON") que compite con ellos. Un ejemplo sirve para
 * mostrar la forma del caso, no para reproducir la nota completa.
 */
export const MAX_CHARS_EJEMPLO = 500

/**
 * Cuánto del cuerpo de la nota se le manda al modelo.
 *
 * POR QUÉ 6000 Y NO 3000
 * 3000 venía del commit original del pipeline, sin decisión documentada: un
 * default conservador que nunca se revisó. No es un límite del proveedor —los
 * `max_tokens` son techos de ESCRITURA— sino nuestro, y era el más caro de los
 * tres recortes en términos de calidad: una nota policial argentina abre con lo
 * genérico y deja para el final lo que define el caso (que el agresor era la
 * pareja, que había denuncia previa, que intervino un policía). El marcador de
 * femicidio, la clasificación más importante del proyecto, es justo el que caía
 * en los párrafos cortados.
 *
 * 6000 es lo que el scraper ya guarda: hasta ahora se almacenaban 5000 chars y
 * se enviaban 3000, o sea que se tiraban 2000 que ya estaban en la base.
 *
 * Antes de subirlo más, leer los `prompt_tokens` que ahora quedan en los logs
 * (ver `registrarUso`). Más contexto no es monótonamente mejor: una nota larga
 * con mucho ruido puede empeorar el seguimiento del formato, que es el problema
 * que se viene peleando.
 */
export const MAX_CHARS_NOTICIA = 6000

export function construirEjemplosFewShot(
  ejemplos: Array<{ resumen: string; clasificacion: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const mensajes: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const ej of ejemplos) {
    const efecto = efectoDeClasificacion(ej.clasificacion)
    const resumen = ej.resumen.slice(0, MAX_CHARS_EJEMPLO)
    mensajes.push({
      role: 'user',
      content: `Extraé los datos del siguiente texto:\n---\n${resumen}\n---`,
    })
    mensajes.push({
      role: 'assistant',
      content: JSON.stringify({
        esHechoDelictivo: efecto.snicCodigo !== null,
        snic_codigo: efecto.snicCodigo,
        es_femicidio: efecto.esFemicidio,
        confianzaExtraccion: 90,
      }),
    })
  }
  return mensajes
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
  nombreVictima: string | null
  /**
   * Femicidio no es un código SNIC: es un homicidio doloso (código 1) marcado
   * aparte. Se guarda en la columna hechos_delictivos.femicidio, la misma que
   * usa la ingesta oficial del SAT.
   */
  esFemicidio: boolean
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
Asigná obligatoriamente uno de estos códigos según el hecho principal. Los
nombres son los del catálogo oficial:
- 1 = Homicidios dolosos (incluye muertes en ocasión de robo, sicariato, linchamientos, y TAMBIÉN los femicidios).
- 2 = Homicidios dolosos en grado de tentativa (heridos graves por ataques letales).
- 3 = Muertes en siniestros viales (SOLO tránsito: choques, atropellamientos).
- 4 = Homicidios culposos por otros hechos (negligencia médica, accidentes laborales, imprudencia no vial).
- 0 = Muerte violenta en investigación (cuerpos hallados sin causa clara aún, muerte de causa dudosa).

CÓDIGO 0 — SIEMPRE CON requiereRevision:
Si usás snic_codigo 0, poné también "requiereRevision": true. Un caso sin causa
determinada tiene que pasar por una persona antes de contarse como homicidio: no
se publica en el mapa hasta que alguien lo confirme. Preferí el 0 con revisión
antes que adivinar entre el 1 y el 4 — una muerte de causa dudosa clasificada
como homicidio doloso infla las cifras, y como culposa las oculta.

FEMICIDIO — SE MARCA APARTE, NO ES UN CÓDIGO:
Un femicidio o transfemicidio es un homicidio doloso, así que va con snic_codigo 1
y además con "es_femicidio": true. NUNCA uses el código 4 para un femicidio: ese
código es de homicidios culposos (negligencia, accidentes laborales) y clasificar
un femicidio ahí lo vuelve indistinguible de una muerte accidental.
Marcá es_femicidio true cuando el hecho sea la muerte de una mujer o persona
trans/travesti en un contexto de violencia de género: pareja o expareja, violencia
familiar, violencia sexual, o cuando la noticia lo nombre explícitamente como
femicidio, transfemicidio o crimen de odio por identidad de género.
Si no hay elementos para afirmarlo, poné false. No lo infieras solo del sexo de la
víctima: una mujer víctima de un robo violento no es necesariamente un femicidio.

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
  "nombre_victima": "Nombre completo de la/s víctima/s si figura en la noticia, sino null",
  "es_femicidio": false,
  "requiereRevision": false,
  "confianzaExtraccion": 90
}`

// ════════════════════════════════════════════
// TIPOS INTERNOS Y MAPEO
// ════════════════════════════════════════════

// Nombres alineados con el catálogo real de prisma/seed.ts. Antes el 3 decía
// "Homicidio culposo" y el 4 "Femicidio", ninguno de los dos coincidía con el
// catálogo oficial que se siembra en tipos_delito: el 3 es vial y el 4 es culposo
// no vial. Femicidio no tiene código propio, se marca con el flag esFemicidio.
const SNIC_DESCRIPCION: Record<number, string> = {
  0: 'Muerte violenta en investigación',
  1: 'Homicidios dolosos',
  2: 'Homicidios dolosos en grado de tentativa',
  3: 'Muertes en siniestros viales',
  4: 'Homicidios culposos por otros hechos',
}

/**
 * Mapea la respuesta ya validada al tipo interno del pipeline.
 *
 * Recibe ExtraccionValidada, no el JSON crudo: los rangos, enums, fechas y
 * longitudes ya se verificaron en validarExtraccion(), así que acá no hace
 * falta ningún fallback defensivo.
 */
function mapearRespuesta(resp: ExtraccionValidada): HechoExtraido {
  return {
    esHechoDelictivo: resp.esHechoDelictivo,
    tipoHecho: resp.snicCodigo != null ? (SNIC_DESCRIPCION[resp.snicCodigo] ?? null) : null,
    codigoSnicEstimado: resp.snicCodigo,
    ubicacion: {
      provincia: resp.provincia,
      ciudad: resp.localidad,
      barrio: resp.barrioODireccion,
      direccion: null,
    },
    fecha: resp.fechaHecho,
    cantidadVictimas: resp.cantidadVictimas,
    medioUtilizado: null,
    descripcionBreve: resp.resumenHecho,
    nombreVictima: resp.nombreVictima,
    esFemicidio: resp.esFemicidio,
    confianzaExtraccion: resp.confianzaExtraccion,
    requiereRevision: resp.requiereRevision,
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
  nombreVictima: null,
  esFemicidio: false,
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
  const configActiva = getConfigActiva()
  console.log(`🤖 ${configActiva.descripcion}`)

  // Validar API key para proveedores remotos
  const faltante = credencialFaltante(configActiva)
  if (faltante) {
    console.error(`❌ ${faltante} no configurada en .env`)
    return RESPUESTA_FALLBACK
  }

  const { cliente, config } = crearClienteLLM('Mapa Nacional del Delito - Usina de Justicia')

  const ejemplos = await getFewShotEjemplos()
  const fewShotMessages = construirEjemplosFewShot(ejemplos)

  try {
    // max_tokens 1500 y no 500: el JSON pedido incluye resumen_hecho ("un
    // párrafo") y el validador tolera hasta 4000 chars ahí, así que la salida
    // esperada son 300-500 tokens. 500 dejaba el límite justo en el borde. No
    // es la causa de los cortes en la posición 207 —eso pasa muy por debajo del
    // límite—, pero era un segundo problema real esperando su turno.
    const resultado = await obtenerContenidoLLM({
      etiqueta: urlFuente,
      registrarUso: d => {
        const linea = formatearUso(d, urlFuente)
        if (linea) console.log(linea)
      },
      // Un JSON cortado es justo el caso que un segundo intento suele resolver.
      aceptar: contenido => parsearJsonLLM(contenido).ok,
      ejecutar: () =>
        cliente.chat.completions.create({
          model: config.modelo,
          messages: [
            { role: 'system', content: PROMPT_SISTEMA },
            ...fewShotMessages,
            {
              role: 'user',
              content: `Fecha actual de procesamiento: ${new Date().toISOString().slice(0, 10)}\nURL fuente: ${urlFuente}\n\nExtraé los datos del siguiente texto de noticia policial argentina siguiendo el formato JSON requerido:\n---\n${textoNoticia.slice(0, MAX_CHARS_NOTICIA)}\n---`,
            },
          ],
          temperature: 0.1,
          max_tokens: 1500,
        }),
    })

    if (!resultado.ok) {
      console.error(
        `⚠️ Sin respuesta usable tras ${resultado.intentos} intentos (${resultado.motivo}): ${urlFuente}`
      )
      return RESPUESTA_FALLBACK
    }

    const parseado = parsearJsonLLM(resultado.contenido)
    if (!parseado.ok) {
      // No debería pasar: `aceptar` ya verificó que parsea. Queda por si la
      // condición de aceptación y el parseo se desincronizan.
      console.error(`⚠️ Respuesta del modelo no parseable (${urlFuente}): ${parseado.errores.join('; ')}`)
      return RESPUESTA_FALLBACK
    }

    // Validación runtime completa. Antes esto era `JSON.parse(x) as LLMRespuesta`
    // con un solo chequeo de esHechoDelictivo, así que fechas, confianza,
    // cantidades y códigos SNIC arbitrarios se convertían en datos de la base.
    const validado = validarExtraccion(parseado.valor)
    if (!validado.ok) {
      console.error(
        `⚠️ Respuesta del modelo inválida (${urlFuente}): ${validado.errores.join('; ')}`
      )
      // Se descarta explícitamente en lugar de insertar datos a medias.
      return RESPUESTA_FALLBACK
    }

    return mapearRespuesta(validado.valor)

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Error extrayendo datos de ${urlFuente}: ${errorMsg}`)
    return RESPUESTA_FALLBACK
  }
}
