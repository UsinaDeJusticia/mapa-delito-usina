/**
 * Observabilidad y reintentos para las llamadas al LLM del pipeline.
 *
 * EL PROBLEMA QUE RESUELVE
 * El pipeline descarta casi todo lo que encuentra: 23 de 24 noticias el 19/8,
 * 11 de 11 el 17/8. Los logs solo decían "⚠️ Modelo devolvió respuesta vacía" o
 * "JSON inválido: Unterminated string in JSON at position 207", sin registrar
 * qué había devuelto el modelo. Con eso es imposible saber por qué.
 *
 * Y el dato que descarta la hipótesis obvia: los cortes eran en las posiciones
 * 37 / 207 / 214 —unos 60 tokens— con `max_tokens: 500` en un prompt y 800 en
 * el otro, y el de 800 se cortaba en la MISMA posición 207. O sea que el límite
 * de tokens no era lo que cortaba.
 *
 * Contenido vacío + fragmento cortísimo es la firma de dos cosas posibles: un
 * modelo de razonamiento que gasta el presupuesto de salida en tokens de
 * reasoning y deja `message.content` vacío, o un gateway que cierra la
 * respuesta antes de terminar. Para distinguirlas hay que mirar
 * `finish_reason`, `usage` y los campos no estándar del mensaje — que es
 * exactamente lo que no se estaba registrando.
 *
 * DOS COSAS, POR SEPARADO
 * 1. `diagnosticar()` / `formatearDiagnostico()`: qué devolvió el modelo.
 *    Sirve para averiguar la causa, sin arreglarla.
 * 2. `obtenerContenidoLLM()`: reintento con backoff. Vale igual, sea cual sea
 *    la causa — hoy no hay ninguno. Los `maxRetries: 2` que trae la SDK de
 *    OpenAI cubren errores de conexión y 4xx/5xx, pero **un 200 con cuerpo
 *    vacío o cortado no se reintenta jamás**, y cada fallo descarta la noticia
 *    para siempre.
 */

/** Campos que la API de OpenAI define en `choices[0].message`. */
const CAMPOS_ESTANDAR_MENSAJE = new Set([
  'role',
  'content',
  'refusal',
  'tool_calls',
  'function_call',
  'audio',
  'annotations',
])

/** Cuánto del contenido crudo se loguea. Suficiente para ver la forma. */
export const MAX_CHARS_LOG = 300

export interface DiagnosticoLLM {
  finishReason: string | null
  usage: Record<string, unknown> | null
  contenido: string
  largoContenido: number
  /**
   * Campos presentes en `message` que no son de la API estándar. Acá aparecería
   * `reasoning_content` si el proveedor manda el razonamiento aparte del
   * contenido — que es una de las dos hipótesis sobre por qué llega vacío.
   */
  camposNoEstandar: string[]
  vacio: boolean
}

/** Extrae de una respuesta cruda todo lo que hace falta para diagnosticar. */
export function diagnosticar(respuesta: unknown): DiagnosticoLLM {
  const r = respuesta as
    | {
        choices?: Array<{
          finish_reason?: unknown
          message?: Record<string, unknown>
        }>
        usage?: unknown
      }
    | null
    | undefined

  const choice = r?.choices?.[0]
  const mensaje = choice?.message
  const contenidoCrudo = mensaje?.['content']
  const contenido = typeof contenidoCrudo === 'string' ? contenidoCrudo.trim() : ''

  const camposNoEstandar = mensaje
    ? Object.keys(mensaje).filter(k => !CAMPOS_ESTANDAR_MENSAJE.has(k))
    : []

  return {
    finishReason:
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage:
      r?.usage && typeof r.usage === 'object'
        ? (r.usage as Record<string, unknown>)
        : null,
    contenido,
    largoContenido: contenido.length,
    camposNoEstandar,
    vacio: contenido === '',
  }
}

/**
 * Arma una línea de log con el diagnóstico.
 *
 * Incluye la URL: el log de "respuesta vacía" no la traía, así que no se podía
 * saber sobre qué noticia había fallado.
 */
export function formatearDiagnostico(
  d: DiagnosticoLLM,
  etiqueta: string
): string {
  const partes = [
    `finish_reason=${d.finishReason ?? 'sin dato'}`,
    `largo_contenido=${d.largoContenido}`,
  ]
  if (d.usage) partes.push(`usage=${JSON.stringify(d.usage)}`)
  if (d.camposNoEstandar.length > 0) {
    // Lo más informativo de todo si el proveedor manda reasoning aparte.
    partes.push(`campos_no_estandar=[${d.camposNoEstandar.join(', ')}]`)
  }
  const recorte = d.contenido.slice(0, MAX_CHARS_LOG)
  const sufijo = d.contenido.length > MAX_CHARS_LOG ? '…' : ''
  partes.push(`crudo=${JSON.stringify(recorte + sufijo)}`)
  return `${etiqueta} | ${partes.join(' ')}`
}

/**
 * Línea de log del camino de éxito: solo el consumo.
 *
 * No reusa `formatearDiagnostico` a propósito: ese incluye el contenido crudo,
 * que en un éxito es la extracción completa. Loguearla por cada nota llenaría
 * la corrida de ruido y taparía justamente lo que se quiere leer.
 *
 * Devuelve null si el proveedor no manda `usage`: no hay nada que medir y una
 * línea vacía por nota es peor que ninguna.
 */
export function formatearUso(d: DiagnosticoLLM, etiqueta: string): string | null {
  if (!d.usage) return null
  return `📊 ${etiqueta} | usage=${JSON.stringify(d.usage)} largo_contenido=${d.largoContenido}`
}

export interface OpcionesLlamada {
  /** Hace la llamada al proveedor. Se invoca una vez por intento. */
  ejecutar: () => Promise<unknown>
  /** Para los logs: la URL de la noticia, o el nombre del medio. */
  etiqueta: string
  /**
   * Decide si el contenido sirve. Si devuelve false se reintenta, porque un
   * JSON cortado es justamente el caso que un segundo intento suele resolver.
   * Si no se pasa, alcanza con que no esté vacío.
   */
  aceptar?: (contenido: string) => boolean
  /** Intentos totales, no reintentos. Default 3. */
  intentos?: number
  /** Espera antes del intento N (1-based). Default: 500ms × intento. */
  esperaMs?: (intentoFallido: number) => number
  /** Inyectable para testear sin esperar de verdad. */
  dormir?: (ms: number) => Promise<void>
  /** Inyectable para no ensuciar la salida en los tests. */
  registrar?: (mensaje: string) => void
  /**
   * Se invoca con el diagnóstico del intento que SALIÓ BIEN.
   *
   * POR QUÉ EXISTE
   * El diagnóstico se registraba solo en los intentos fallidos. Eso alcanzaba
   * para encontrar por qué fallaban, pero cuando los fallos bajaron quedamos
   * sin un solo `prompt_tokens` real con el que elegir cuánto texto mandarle al
   * modelo — y esos recortes (el snapshot del sitio, el cuerpo de la nota) son
   * justo donde se pierden femicidios. Sin medir el éxito, los límites se
   * eligen a ojo.
   *
   * Default `undefined` = no loguea nada, para que ningún consumidor herede
   * ruido que no pidió.
   */
  registrarUso?: (diagnostico: DiagnosticoLLM) => void
}

export type ResultadoLlamada =
  | { ok: true; contenido: string; intentos: number }
  | { ok: false; motivo: string; intentos: number }

const dormirReal = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Llama al LLM y devuelve contenido usable, reintentando ante vacío, contenido
 * no aceptable, o excepción.
 *
 * Deja registrado el diagnóstico de CADA intento fallido: si el problema es del
 * proveedor, el patrón se ve en los logs (por ejemplo, `finish_reason=length`
 * en todos, o un `usage` con muchos tokens de salida y contenido vacío).
 *
 * Y con `registrarUso`, también el consumo del intento que salió bien — que es
 * el único dato con el que se pueden elegir los recortes de entrada.
 */
export async function obtenerContenidoLLM({
  ejecutar,
  etiqueta,
  aceptar,
  intentos = 3,
  esperaMs = intento => 500 * intento,
  dormir = dormirReal,
  registrar = console.error,
  registrarUso,
}: OpcionesLlamada): Promise<ResultadoLlamada> {
  let ultimoMotivo = 'sin intentos'

  for (let intento = 1; intento <= intentos; intento++) {
    let diagnostico: DiagnosticoLLM | null = null
    try {
      const respuesta = await ejecutar()
      diagnostico = diagnosticar(respuesta)

      if (!diagnostico.vacio && (!aceptar || aceptar(diagnostico.contenido))) {
        // Antes del `return`: es la única rama donde el éxito se puede medir.
        registrarUso?.(diagnostico)
        if (intento > 1) {
          registrar(`✅ ${etiqueta} | resuelto en el intento ${intento}/${intentos}`)
        }
        return { ok: true, contenido: diagnostico.contenido, intentos: intento }
      }

      ultimoMotivo = diagnostico.vacio ? 'respuesta vacía' : 'contenido no usable'
    } catch (error) {
      ultimoMotivo = `error del proveedor: ${
        error instanceof Error ? error.message : String(error)
      }`
    }

    const detalle = diagnostico
      ? formatearDiagnostico(diagnostico, etiqueta)
      : `${etiqueta} | ${ultimoMotivo}`
    registrar(`⚠️ intento ${intento}/${intentos} — ${ultimoMotivo} — ${detalle}`)

    if (intento < intentos) {
      await dormir(esperaMs(intento))
    }
  }

  return { ok: false, motivo: ultimoMotivo, intentos }
}
