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

import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import {
  PERFILES_MODELO,
  getConfigActiva,
  getNivelRazonamiento,
  getPerfilRespaldoConfigurado,
  type ConfigModelo,
  type PerfilModelo,
  type ProveedorLLM,
} from '@/config/modelos-pipeline'
import { estadoHttpDeError, mensajeDeError } from '@/lib/pipeline/llamada-llm'

/** Env var que guarda la API key de cada proveedor. null = no necesita key. */
const ENV_API_KEY: Record<ProveedorLLM, string | null> = {
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: null, // corre local, sin autenticación
}

/**
 * User-Agent propio del pipeline.
 *
 * OpenCode Go pide que cada cliente se identifique con su propio user agent
 * ("my-coding-agent/1.0") y no con el nombre genérico de la librería HTTP: el
 * default del SDK es `OpenAI/JS x.y.z`, indistinguible de cualquier script. Se
 * manda a todos los proveedores porque identificarse no le cuesta nada a
 * OpenRouter ni a Ollama.
 */
export const USER_AGENT_PIPELINE = 'usina-mapa-delito/1.0 (+https://usinadejusticia.org.ar)'

/** Header que OpenCode Go exige desde el 06/09/2026. */
export const HEADER_SESION_OPENCODE = 'x-opencode-session'

/**
 * Un ID de sesión estable por consumidor, dentro de un mismo proceso.
 *
 * POR QUÉ EXISTE
 * Desde el 06/09/2026 OpenCode Go rechaza con
 *   400 Request is missing x-opencode-session and cannot be routed efficiently
 * toda request que no traiga ese header. El pipeline no lo mandaba: las
 * corridas diarias del 7 al 24/9 fallaron en la primera llamada de cada medio
 * y aun así terminaron en verde, con cero noticias.
 *
 * QUÉ ES UNA "SESIÓN" ACÁ
 * Go usa el header para mandar las requests de una misma conversación al mismo
 * proveedor y aprovechar el caché de prompts. En el pipeline, lo que comparte
 * prefijo es cada consumidor dentro de una corrida: todas las identificaciones
 * llevan el mismo system prompt, todas las extracciones el mismo system prompt
 * más few-shot, y la deduplicación el suyo. Por eso la sesión es por
 * (proceso, consumidor): una corrida nueva abre sesiones nuevas, y las llamadas
 * de un mismo consumidor viajan juntas — lo que maximiza los `cached_tokens`
 * que ya se ven en los logs.
 */
const sesionesPorConsumidor = new Map<string, string>()

export function idSesionLLM(consumidor: string): string {
  let id = sesionesPorConsumidor.get(consumidor)
  if (!id) {
    id = randomUUID()
    sesionesPorConsumidor.set(consumidor, id)
  }
  return id
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
 * Timeout por request. El default del SDK son 10 minutos, que es lo que hoy
 * hace falta: con el razonamiento en alto, una identificación llegó a tardar
 * 6. Se puede bajar con PIPELINE_LLM_TIMEOUT_MS si se baja el razonamiento.
 */
function timeoutMs(): number | undefined {
  const n = Number(process.env.PIPELINE_LLM_TIMEOUT_MS)
  return Number.isFinite(n) && n >= 10_000 ? n : undefined
}

/** Headers que manda cada request según el proveedor. Exportado para testear. */
export function headersPara(config: ConfigModelo, consumidor: string): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT_PIPELINE }
  if (config.proveedor === 'opencode') {
    headers[HEADER_SESION_OPENCODE] = idSesionLLM(consumidor)
  }
  if (config.proveedor === 'openrouter') {
    headers['HTTP-Referer'] = 'https://usinadejusticia.org.ar'
    headers['X-Title'] = consumidor
  }
  return headers
}

/**
 * @param titulo Nombre del consumidor. Es la clave de la sesión de OpenCode Go
 *               y el header de atribución X-Title de OpenRouter.
 * @param opciones.fetch Inyectable para testear sin red.
 */
export function crearClienteLLM(
  titulo: string,
  opciones: { fetch?: typeof fetch } = {}
): { cliente: OpenAI; config: ConfigModelo } {
  const config = getConfigActiva()
  const envVar = ENV_API_KEY[config.proveedor]
  const apiKey = envVar ? (process.env[envVar] ?? '') : 'ollama'

  // Ollama publica su API compatible con OpenAI bajo /v1; los gateways
  // remotos ya incluyen la versión en su baseUrl.
  const baseURL = config.proveedor === 'ollama' ? `${config.baseUrl}/v1` : config.baseUrl

  const cliente = new OpenAI({
    baseURL,
    apiKey,
    defaultHeaders: headersPara(config, titulo),
    ...(timeoutMs() ? { timeout: timeoutMs() } : {}),
    ...(opciones.fetch ? { fetch: opciones.fetch } : {}),
  })

  return { cliente, config }
}

// ════════════════════════════════════════════
// PARÁMETROS DE RAZONAMIENTO
// ════════════════════════════════════════════

/**
 * Se apaga para el resto del proceso si el proveedor rechazó el parámetro en
 * la verificación inicial. Mejor una corrida lenta que ninguna.
 */
let razonamientoRechazado = false

/**
 * Campos extra que se suman al body de cada `chat.completions.create`.
 *
 * Hoy solo el control de razonamiento (ver getNivelRazonamiento). Se devuelve
 * un objeto plano para hacer spread: el SDK manda el body tal cual, así que un
 * campo que no está en sus tipos (como `thinking` de DeepSeek) llega igual.
 */
export function parametrosExtraLLM(config: ConfigModelo = getConfigActiva()): Record<string, unknown> {
  if (razonamientoRechazado || config.proveedor === 'ollama') return {}
  const nivel = getNivelRazonamiento()
  if (!nivel) return {}
  if (nivel === 'desactivado') return { thinking: { type: 'disabled' } }
  const esfuerzo = { bajo: 'low', alto: 'high', max: 'max' }[nivel]
  return { reasoning_effort: esfuerzo }
}

// ════════════════════════════════════════════
// VERIFICACIÓN INICIAL DEL PROVEEDOR
// ════════════════════════════════════════════

export type ResultadoVerificacion =
  | { ok: true; ms: number; config: ConfigModelo; avisos: string[] }
  | { ok: false; ms: number; config: ConfigModelo; status: number | null; mensaje: string; avisos: string[] }

/**
 * Una llamada mínima antes de gastar una corrida entera.
 *
 * POR QUÉ EXISTE
 * Con el header faltante, cada corrida gastaba ~6 minutos de browser antes de
 * la primera llamada al LLM, fallaba en todas, y terminaba "exitosa". Con esta
 * verificación el mismo problema se ve en 2 segundos, con el mensaje exacto del
 * proveedor, y la corrida sale con código de error.
 *
 * Solo importa que el proveedor ACEPTE la request (2xx): no se valida el
 * contenido, porque un modelo de razonamiento puede gastar los pocos tokens de
 * la prueba pensando y devolver vacío sin que eso sea un problema.
 */
export async function verificarProveedorLLM(
  opciones: { fetch?: typeof fetch } = {}
): Promise<ResultadoVerificacion> {
  const config = getConfigActiva()
  const avisos: string[] = []
  const inicio = Date.now()

  const faltante = credencialFaltante(config)
  if (faltante) {
    return { ok: false, ms: 0, config, status: null, mensaje: `falta la variable ${faltante}`, avisos }
  }

  const { cliente } = crearClienteLLM('Mapa del Delito - Verificación', opciones)
  const probar = (extra: Record<string, unknown>) =>
    cliente.chat.completions.create(
      {
        model: config.modelo,
        messages: [{ role: 'user', content: 'Respondé únicamente con la palabra OK.' }],
        max_tokens: 16,
        ...(extra as object),
      },
      { timeout: 120_000, maxRetries: 1 }
    )

  const extra = parametrosExtraLLM(config)
  try {
    await probar(extra)
    return { ok: true, ms: Date.now() - inicio, config, avisos }
  } catch (error) {
    const status = estadoHttpDeError(error)
    // Si lo rechazado pudo ser el parámetro de razonamiento, se prueba sin él
    // antes de declarar caído al proveedor.
    if (status === 400 && Object.keys(extra).length > 0) {
      try {
        await probar({})
        razonamientoRechazado = true
        avisos.push(
          `el proveedor rechazó PIPELINE_LLM_RAZONAMIENTO (${mensajeDeError(error)}); la corrida sigue sin ese parámetro`
        )
        return { ok: true, ms: Date.now() - inicio, config, avisos }
      } catch (error2) {
        return {
          ok: false, ms: Date.now() - inicio, config,
          status: estadoHttpDeError(error2), mensaje: mensajeDeError(error2), avisos,
        }
      }
    }
    return { ok: false, ms: Date.now() - inicio, config, status, mensaje: mensajeDeError(error), avisos }
  }
}

/**
 * Perfil de respaldo utilizable ahora: configurado Y con credenciales.
 * null si no hay a dónde caer.
 */
export function perfilRespaldoDisponible(): PerfilModelo | null {
  const candidato = getPerfilRespaldoConfigurado()
  if (!candidato) return null
  return credencialFaltante(PERFILES_MODELO[candidato]) ? null : candidato
}
