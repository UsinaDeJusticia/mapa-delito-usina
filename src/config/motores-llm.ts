/**
 * Registro de motores LLM configurables por archivo — la pieza que hace que
 * agregar un proveedor sea "una entrada en un JSON", no "editar TypeScript".
 *
 * FUENTE DE VERDAD
 * `config/motores-llm.json`, en la raíz del repo. Se puede sobrescribir por
 * completo con la env var `LLM_MOTORES` (el JSON entero como string) — para
 * CI o Vercel, donde no hay filesystem editable entre despliegues. En un VPS
 * se edita el archivo y se reinicia el proceso; en Actions o Vercel se setea
 * la env var. En ningún caso se toca código.
 *
 * QUÉ NO VA ACÁ
 * La API key. El JSON (y `LLM_MOTORES`) solo guardan el *nombre* de la env
 * var que la contiene (`apiKeyEnv`), nunca el valor. Así el archivo se puede
 * commitear y leer en una review sin exponer un secreto — y `LLM_MOTORES` en
 * los logs de CI tampoco los expone.
 *
 * ACTIVACIÓN POR PRESENCIA DE CREDENCIAL
 * Un motor con `apiKeyEnv` seteado se activa solo si esa env var tiene un
 * valor no vacío (ver `envOverride` en `modelos-pipeline.ts`: en GitHub
 * Actions un secret no configurado llega como `''`, no como ausente, y `??`
 * no lo atrapa — el mismo criterio se aplica aquí). Si no está seteada, el
 * motor se saltea en silencio: no rompe la corrida, y agregar la key luego
 * lo activa sin deploy. Un motor sin `apiKeyEnv` (protocolo local, sin auth)
 * está siempre disponible.
 *
 * PROTOCOLO
 * `protocolo` default `"openai"`: cubre todo lo que hable la API de OpenAI o
 * un superset compatible — DeepSeek directo, Qwen/DashScope, Moonshot/Kimi,
 * Zhipu GLM, OpenAI, OpenRouter, OpenCode Go, Hermes, Ollama, la capa de
 * compatibilidad de Gemini. Para todos esos, sumar un proveedor es una
 * entrada en el JSON. Claude no habla ese protocolo (ver
 * `src/lib/mapa/cliente-llm.ts`), por eso existe `protocolo: "anthropic"`
 * como adaptador aparte.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { envOverride, getConfigActiva, getPerfilActivo, type ProveedorLLM } from '@/config/modelos-pipeline'

export type ProtocoloLLM = 'openai' | 'anthropic'

export interface MotorLLMConfig {
  id: string
  protocolo: ProtocoloLLM
  baseUrl?: string
  /** Nombre de la env var que contiene la API key. Ausente = no requiere auth. */
  apiKeyEnv?: string
  modelo: string
  costoEntradaPorMil: number
  concurrencia?: number
}

export type TareaLLM = 'identificacion' | 'extraccion' | 'dedup'

const RUTA_DEFAULT = path.join(process.cwd(), 'config', 'motores-llm.json')

/**
 * Parsea y valida la forma de la config de motores.
 *
 * Exportada aparte de `getMotoresConfigurados()` para poder testear el
 * parseo con JSON de prueba sin tocar el filesystem ni las env vars — y
 * porque es el punto exacto donde hay que aplicar el mismo criterio que
 * `envOverride`: un JSON `''` (LLM_MOTORES seteada pero vacía, el caso de
 * Actions) tiene que tratarse como "no hay override", no como "config
 * vacía" que apagaría todos los motores.
 */
export function parsearMotores(json: string): MotorLLMConfig[] {
  let datos: unknown
  try {
    datos = JSON.parse(json)
  } catch (error) {
    throw new Error(
      `motores-llm: JSON inválido — ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!Array.isArray(datos)) {
    throw new Error('motores-llm: la config tiene que ser un array de motores')
  }
  return datos.map((entrada, i) => validarMotor(entrada, i))
}

/**
 * Red de seguridad: que el diseño ("la API key nunca va en el archivo, solo
 * el nombre de la env var") no dependa solo de que nadie se equivoque.
 *
 * Dos criterios, elegidos para no dar falsos positivos con los campos
 * legítimos del schema (`id`, `modelo`, `baseUrl`, `apiKeyEnv` — un nombre de
 * env var como "OPENCODE_API_KEY" no matchea ningún patrón de key real):
 *
 * 1. Un campo llamado literalmente "apiKey" (no "apiKeyEnv"): quien lo puso
 *    ahí casi seguro puso el valor, no el nombre de la variable.
 * 2. Un valor de STRING que tiene la forma de una key real de un proveedor
 *    conocido — prefijos como `sk-`, `sk-ant-`, `AIza` (Google), o un token
 *    `Bearer …`. Se compara CUALQUIER valor string del objeto, no solo
 *    campos con nombre sospechoso, porque el error real sería pegar la key
 *    en el campo equivocado (ej. en "modelo" por error de copy-paste).
 *
 * Deliberadamente NO flaggea strings largos en general (rompería con
 * `baseUrl` o `modelo` legítimos) ni el nombre de la env var en sí.
 */
const PATRONES_KEY_LITERAL = [
  /^sk-ant-/i, // Anthropic
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI / muchos compatibles
  /^AIza[0-9A-Za-z_-]{20,}$/, // Google
  /^Bearer\s+\S+/i,
  /^gsk_[A-Za-z0-9]{16,}$/, // Groq
]

export function hallazgosCredencialLiteral(json: string): string[] {
  let datos: unknown
  try {
    datos = JSON.parse(json)
  } catch {
    return [] // JSON inválido lo reporta parsearMotores(); este guard no duplica el error
  }
  if (!Array.isArray(datos)) return []

  const hallazgos: string[] = []
  datos.forEach((entrada, i) => {
    if (typeof entrada !== 'object' || entrada === null) return
    for (const [campo, valor] of Object.entries(entrada as Record<string, unknown>)) {
      if (campo === 'apiKey') {
        hallazgos.push(`motores[${i}]: tiene un campo "apiKey" — tiene que ser "apiKeyEnv" con el NOMBRE de la env var, no el valor`)
        continue
      }
      if (typeof valor === 'string' && PATRONES_KEY_LITERAL.some(p => p.test(valor))) {
        hallazgos.push(`motores[${i}].${campo}: el valor tiene forma de API key real, no de config`)
      }
    }
  })
  return hallazgos
}

function validarMotor(entrada: unknown, indice: number): MotorLLMConfig {
  if (typeof entrada !== 'object' || entrada === null) {
    throw new Error(`motores-llm[${indice}]: cada motor tiene que ser un objeto`)
  }
  const m = entrada as Record<string, unknown>
  if (typeof m.id !== 'string' || !m.id.trim()) {
    throw new Error(`motores-llm[${indice}]: falta "id"`)
  }
  if (typeof m.modelo !== 'string' || !m.modelo.trim()) {
    throw new Error(`motores-llm[${indice}] (${m.id}): falta "modelo"`)
  }
  const protocolo = m.protocolo === undefined ? 'openai' : m.protocolo
  if (protocolo !== 'openai' && protocolo !== 'anthropic') {
    throw new Error(`motores-llm[${indice}] (${m.id}): protocolo desconocido "${String(protocolo)}"`)
  }
  if (m.apiKeyEnv !== undefined && typeof m.apiKeyEnv !== 'string') {
    throw new Error(`motores-llm[${indice}] (${m.id}): "apiKeyEnv" tiene que ser string`)
  }
  if (m.baseUrl !== undefined && typeof m.baseUrl !== 'string') {
    throw new Error(`motores-llm[${indice}] (${m.id}): "baseUrl" tiene que ser string`)
  }
  const costo = typeof m.costoEntradaPorMil === 'number' ? m.costoEntradaPorMil : 0
  const concurrencia = typeof m.concurrencia === 'number' ? m.concurrencia : undefined

  return {
    id: m.id,
    protocolo,
    baseUrl: m.baseUrl as string | undefined,
    apiKeyEnv: m.apiKeyEnv as string | undefined,
    modelo: m.modelo,
    costoEntradaPorMil: costo,
    concurrencia,
  }
}

/**
 * Lee la config activa: `LLM_MOTORES` si tiene contenido real, si no el
 * archivo `config/motores-llm.json`.
 *
 * Sin caché: cada llamada relee. El pipeline hace pocas llamadas por corrida
 * comparado con el costo de una lectura de archivo/env, y así un cambio al
 * JSON en un VPS se recoge sin reiniciar. Los tests pueden pisar `LLM_MOTORES`
 * en cada caso sin pelearse con una caché de proceso.
 */
export function getMotoresConfigurados(rutaArchivo: string = RUTA_DEFAULT): MotorLLMConfig[] {
  const override = envOverride(process.env.LLM_MOTORES, '')
  if (override) {
    return parsearMotores(override)
  }
  try {
    const contenido = readFileSync(rutaArchivo, 'utf-8')
    return parsearMotores(contenido)
  } catch (error) {
    // Un archivo ausente o corrupto no puede tirar abajo el pipeline: sin él,
    // el sistema sigue funcionando con el motor legacy de PIPELINE_PERFIL_MODELO.
    console.error(
      `⚠️ motores-llm: no se pudo leer ${rutaArchivo} — ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return []
  }
}

/**
 * true si la env var de un motor tiene un valor real (no ausente, no `''`).
 * Mismo criterio que `envOverride`: una env var presente pero vacía (el caso
 * de un secret de Actions nunca configurado) cuenta como ausente.
 */
export function motorDisponible(motor: Pick<MotorLLMConfig, 'apiKeyEnv'>): boolean {
  if (!motor.apiKeyEnv) return true // protocolo sin auth (ej. Ollama local)
  return envOverride(process.env[motor.apiKeyEnv], '') !== ''
}

/** Nombre de la env var que falta para activar el motor, o null si ya está. */
export function credencialFaltanteDeMotor(motor: Pick<MotorLLMConfig, 'apiKeyEnv'>): string | null {
  if (!motor.apiKeyEnv) return null
  return motorDisponible(motor) ? null : motor.apiKeyEnv
}

// ════════════════════════════════════════════
// PUENTE CON EL SISTEMA LEGACY (PIPELINE_PERFIL_MODELO)
// ════════════════════════════════════════════
//
// `PIPELINE_PERFIL_MODELO` sigue vivo en pipeline.yml y en los .env de todos
// los entornos: no se puede dejar de resolverlo. Se lo modela como un motor
// más — el primero de cualquier política — así el intento 1 usa exactamente
// el mismo proveedor/modelo que hoy (cero cambio de comportamiento en
// producción sin tocar el JSON), y los motores del JSON quedan como
// escalada real para cuando ese falla.

const PROVEEDOR_A_PROTOCOLO: Record<ProveedorLLM, ProtocoloLLM> = {
  opencode: 'openai',
  openrouter: 'openai',
  ollama: 'openai',
}

const PROVEEDOR_A_APIKEY_ENV: Record<ProveedorLLM, string | undefined> = {
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: undefined,
}

/** El perfil activo hoy (PIPELINE_PERFIL_MODELO), modelado como MotorLLMConfig. */
export function motorLegacyActivo(): MotorLLMConfig {
  const perfil = getPerfilActivo()
  const config = getConfigActiva()
  const baseUrl = config.proveedor === 'ollama' ? `${config.baseUrl}/v1` : config.baseUrl
  return {
    id: `legacy:${perfil}`,
    protocolo: PROVEEDOR_A_PROTOCOLO[config.proveedor],
    baseUrl,
    apiKeyEnv: PROVEEDOR_A_APIKEY_ENV[config.proveedor],
    modelo: config.modelo,
    costoEntradaPorMil: config.costoPorMilTokens,
  }
}

// ════════════════════════════════════════════
// POLÍTICAS POR TAREA
// ════════════════════════════════════════════
//
// Orden de preferencia por tarea, referenciando ids del JSON. Si un id no
// está configurado (no aparece en el JSON activo) se lo ignora sin error:
// las políticas describen una preferencia, no una dependencia dura. La
// dedup prioriza lo más barato; la extracción (donde se decide si algo es
// un femicidio) prioriza precisión.
const POLITICAS: Record<TareaLLM, string[]> = {
  identificacion: ['go-flash', 'openrouter-respaldo', 'go-preciso'],
  extraccion: ['go-preciso', 'go-flash', 'openrouter-respaldo'],
  dedup: ['go-flash', 'openrouter-respaldo', 'go-preciso'],
}

/**
 * Resuelve, para una tarea, la lista ordenada de motores a intentar:
 *
 * 1. El motor legacy activo (PIPELINE_PERFIL_MODELO) siempre primero — así el
 *    intento 1 nunca cambia por el solo hecho de que exista este módulo.
 * 2. Los motores del JSON en el orden que declara la política de la tarea.
 * 3. Cualquier motor del JSON no mencionado en la política, como red final.
 *
 * Sin filtrar por credenciales todavía: eso lo hace el llamador (o
 * `resolverPoliticaDisponible`) para poder decidir qué hacer si no queda
 * ninguno (hoy: loguear y devolver el fallback de la tarea).
 */
export function resolverPolitica(tarea: TareaLLM, motoresConfigurados: MotorLLMConfig[] = getMotoresConfigurados()): MotorLLMConfig[] {
  const porId = new Map(motoresConfigurados.map(m => [m.id, m]))
  const ordenados: MotorLLMConfig[] = [motorLegacyActivo()]
  const vistos = new Set(ordenados.map(m => m.id))

  for (const id of POLITICAS[tarea]) {
    const motor = porId.get(id)
    if (motor && !vistos.has(motor.id)) {
      ordenados.push(motor)
      vistos.add(motor.id)
    }
  }
  for (const motor of motoresConfigurados) {
    if (!vistos.has(motor.id)) {
      ordenados.push(motor)
      vistos.add(motor.id)
    }
  }
  return ordenados
}

/** Igual que `resolverPolitica`, pero filtrando a los que tienen credencial presente. */
export function resolverPoliticaDisponible(
  tarea: TareaLLM,
  motoresConfigurados: MotorLLMConfig[] = getMotoresConfigurados()
): MotorLLMConfig[] {
  return resolverPolitica(tarea, motoresConfigurados).filter(motorDisponible)
}
