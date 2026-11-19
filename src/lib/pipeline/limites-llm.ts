/**
 * Techos de salida (max_tokens) de cada llamada al LLM del pipeline.
 *
 * deepseek-v4.1-flash es un modelo de razonamiento: los tokens que "piensa"
 * cuentan dentro de max_tokens. Con los techos viejos (800 / 1500 / 600) el
 * modelo se gastaba todo pensando y devolvía la respuesta vacía
 * (finish_reason=length, reasoning_tokens == completion_tokens): el 19/11/2026
 * 5 de los 13 medios —Infobae entre ellos— volvieron sin noticias por eso.
 *
 * Son TECHOS, no consumo: se paga solo lo que el modelo usa. Por eso se dejan
 * holgados a propósito; con el precio de DeepSeek la diferencia son centavos
 * por mes. Lo único que crece con más razonamiento es la duración de cada
 * llamada (el agente de Cloudflare corta una encendida a los 150 min).
 */
export const MAX_TOKENS_LLM = {
  /** Prompt 1: elegir los links de homicidios en la portada (la salida es corta, el razonamiento no). */
  identificacion: 16_000,
  /** Prompt 2: extraer los datos estructurados de una nota. */
  extraccion: 12_000,
  /** Deduplicación: ¿hecho nuevo o cobertura de uno existente? */
  deduplicacion: 6_000,
} as const
