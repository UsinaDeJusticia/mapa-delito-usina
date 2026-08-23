/**
 * Creación centralizada del cliente LLM del pipeline.
 *
 * Los tres consumidores (extracción de noticias, deduplicación e
 * identificación de links) repetían la misma lógica de proveedor, así que
 * cambiar de proveedor implicaba editar tres archivos y era fácil dejar uno
 * desincronizado. Ahora todos pasan por acá.
 *
 * Los tres proveedores soportados hablan la API de OpenAI, por eso alcanza con
 * el cliente `openai` apuntando el baseURL correspondiente.
 */

import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { getConfigActiva, type ConfigModelo, type ProveedorLLM } from '@/config/modelos-pipeline'
import { credencialFaltanteDeMotor, type MotorLLMConfig } from '@/config/motores-llm'

/** Env var que guarda la API key de cada proveedor. null = no necesita key. */
const ENV_API_KEY: Record<ProveedorLLM, string | null> = {
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null, // corre local, sin autenticación
}

/**
 * Devuelve el nombre de la env var que falta, o null si las credenciales están.
 * Se expone aparte de crearClienteLLM para que quien llame decida qué hacer:
 * la extracción de noticias, por ejemplo, prefiere devolver un fallback antes
 * que cortar toda la corrida.
 */
export function credencialFaltante(config: ConfigModelo = getConfigActiva()): string | null {
  const envVar = ENV_API_KEY[config.proveedor]
  if (!envVar) return null
  return process.env[envVar] ? null : envVar
}

/**
 * @param titulo Nombre del consumidor, para el header de atribución X-Title.
 *               Solo lo usa OpenRouter; los demás proveedores lo ignoran.
 */
export function crearClienteLLM(titulo: string): { cliente: OpenAI; config: ConfigModelo } {
  const config = getConfigActiva()
  const envVar = ENV_API_KEY[config.proveedor]
  const apiKey = envVar ? (process.env[envVar] ?? '') : 'ollama'

  // Ollama publica su API compatible con OpenAI bajo /v1; los gateways
  // remotos ya incluyen la versión en su baseUrl.
  const baseURL = config.proveedor === 'ollama' ? `${config.baseUrl}/v1` : config.baseUrl

  const defaultHeaders = config.proveedor === 'openrouter'
    ? {
        'HTTP-Referer': 'https://usinadejusticia.org.ar',
        'X-Title': titulo,
      }
    : {}

  return { cliente: new OpenAI({ baseURL, apiKey, defaultHeaders }), config }
}

// ════════════════════════════════════════════
// ADAPTADORES MULTI-PROTOCOLO (motores del JSON — config/motores-llm.json)
// ════════════════════════════════════════════
//
// Lo de arriba (`crearClienteLLM`) sigue existiendo para el sistema legacy de
// un solo perfil activo — `scrapear-medios.ts` lo consume tal cual y no se
// toca. Lo de abajo es la capa nueva: un motor resuelto (`MotorLLMConfig`,
// venga del JSON o del puente legacy en `motores-llm.ts`) entra a
// `completarConMotor()` y sale una respuesta con la FORMA de OpenAI
// (`choices[0].message.content`, `usage.prompt_tokens/completion_tokens`),
// sin que el resto del pipeline (`diagnosticar()` en `llamada-llm.ts`, que ya
// espera exactamente esa forma) tenga que saber qué proveedor respondió.
//
// AGREGAR UN TERCER PROTOCOLO (ej. la API nativa de Gemini): un adaptador más
// en este archivo con la misma firma — `(motor, params) => RespuestaTipoOpenAI`
// — y un branch en `completarConMotor`. El resto del sistema (router,
// políticas, tests) no cambia.

/** Lo mínimo que necesita cualquier adaptador para armar un request. */
export interface ParametrosCompletado {
  system: string
  mensajes: Array<{ role: 'user' | 'assistant'; content: string }>
  temperature?: number
  max_tokens: number
}

/**
 * Respuesta normalizada a la forma que `diagnosticar()` ya sabe leer. Es la
 * única forma que circula más allá de este archivo — Anthropic nombra a sus
 * campos de consumo `input_tokens`/`output_tokens`; acá se traducen una sola
 * vez a `prompt_tokens`/`completion_tokens` para que nada aguas abajo tenga
 * que conocer esa diferencia.
 */
export interface RespuestaTipoOpenAI {
  choices: [{ finish_reason: string | null; message: { content: string } }]
  usage: { prompt_tokens: number; completion_tokens: number } | null
}

function apiKeyDeMotor(motor: MotorLLMConfig): string {
  return motor.apiKeyEnv ? (process.env[motor.apiKeyEnv] ?? '') : ''
}

async function completarOpenAI(
  motor: MotorLLMConfig,
  params: ParametrosCompletado
): Promise<RespuestaTipoOpenAI> {
  const apiKey = apiKeyDeMotor(motor)
  // Mismo criterio que crearClienteLLM(): Ollama publica su API bajo /v1;
  // los gateways remotos ya incluyen la versión en su baseUrl.
  const defaultHeaders = motor.baseUrl?.includes('openrouter.ai')
    ? { 'HTTP-Referer': 'https://usinadejusticia.org.ar', 'X-Title': 'Mapa del Delito - Usina de Justicia' }
    : {}
  const cliente = new OpenAI({ baseURL: motor.baseUrl, apiKey: apiKey || 'sin-auth', defaultHeaders })
  const respuesta = await cliente.chat.completions.create({
    model: motor.modelo,
    messages: [
      { role: 'system', content: params.system },
      ...params.mensajes,
    ],
    temperature: params.temperature,
    max_tokens: params.max_tokens,
  })
  // El cliente OpenAI ya devuelve exactamente esta forma; se castea porque
  // acá solo interesan los campos que RespuestaTipoOpenAI declara.
  return respuesta as unknown as RespuestaTipoOpenAI
}

/**
 * La API de Claude NO es compatible con la de OpenAI (verificado, no es un
 * supuesto): `system` va como parámetro top-level y no como mensaje con
 * `role: "system"`; el contenido de la respuesta son bloques
 * (`content: [{type:"text", text:"..."}]`, puede haber más de uno o de otro
 * tipo); `max_tokens` es obligatorio (OpenAI lo trata como opcional); y el
 * consumo llega como `usage.input_tokens` / `usage.output_tokens`, no
 * `prompt_tokens` / `completion_tokens`. El SDK oficial ya reintenta
 * 408/409/429/5xx por su cuenta (`maxRetries` default 2) — no se pisa nada de
 * eso, `obtenerContenidoLLM` sigue encima escalando entre motores si el
 * adaptador termina fallando igual.
 */
/**
 * Traduce los parámetros genéricos al request que espera el SDK de Anthropic:
 * `system` sale de `messages` y se manda aparte, como pide esa API.
 * Separada de `completarAnthropic` para poder testear la traducción sin
 * tocar la red — no depende de nada de Anthropic salvo el tipo del SDK.
 */
export function armarRequestAnthropic(
  motor: Pick<MotorLLMConfig, 'modelo'>,
  params: ParametrosCompletado
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: motor.modelo,
    max_tokens: params.max_tokens,
    system: params.system,
    temperature: params.temperature,
    messages: params.mensajes,
  }
}

/**
 * Traduce la respuesta cruda del SDK de Anthropic a la forma tipo-OpenAI.
 * Pura y separada de `completarAnthropic` por la misma razón: testear la
 * traducción de bloques de contenido y de `usage` sin hacer un request real.
 */
export function normalizarRespuestaAnthropic(
  respuesta: Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>
): RespuestaTipoOpenAI {
  const contenido = respuesta.content
    .filter((bloque): bloque is Anthropic.TextBlock => bloque.type === 'text')
    .map(bloque => bloque.text)
    .join('')

  return {
    choices: [{ finish_reason: respuesta.stop_reason ?? null, message: { content: contenido } }],
    usage: respuesta.usage
      ? {
          prompt_tokens: respuesta.usage.input_tokens,
          completion_tokens: respuesta.usage.output_tokens,
        }
      : null,
  }
}

async function completarAnthropic(
  motor: MotorLLMConfig,
  params: ParametrosCompletado
): Promise<RespuestaTipoOpenAI> {
  const apiKey = apiKeyDeMotor(motor)
  const cliente = new Anthropic({ apiKey })
  const respuesta = await cliente.messages.create(armarRequestAnthropic(motor, params))
  return normalizarRespuestaAnthropic(respuesta)
}

/**
 * Ejecuta un request contra el motor dado, cualquiera sea su protocolo, y
 * devuelve siempre la forma tipo-OpenAI que el resto del pipeline consume.
 * Es el único punto donde `protocolo` decide qué SDK se usa.
 */
export async function completarConMotor(
  motor: MotorLLMConfig,
  params: ParametrosCompletado
): Promise<RespuestaTipoOpenAI> {
  if (motor.protocolo === 'anthropic') return completarAnthropic(motor, params)
  return completarOpenAI(motor, params)
}

/** Re-exportado por comodidad: mismo chequeo de credencial, para un MotorLLMConfig. */
export { credencialFaltanteDeMotor }
