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
import { getConfigActiva, type ConfigModelo, type ProveedorLLM } from '@/config/modelos-pipeline'

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
