export type PerfilModelo = 'economico' | 'preciso' | 'openrouter' | 'local'

export type ProveedorLLM = 'opencode' | 'openrouter' | 'ollama'

export interface ConfigModelo {
  proveedor: ProveedorLLM
  modelo: string
  baseUrl: string
  descripcion: string
  /** Costo de entrada por 1.000 tokens, para estimar el gasto de una corrida */
  costoPorMilTokens: number
}

// OpenCode Go expone una API compatible con OpenAI en /zen/go/v1, así que el
// cliente `openai` funciona apuntándole el baseURL.
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go/v1'

/**
 * Lee un override opcional, tratando cadena vacía como "no seteado".
 *
 * `??` no alcanza acá: en GitHub Actions, `${{ secrets.X }}` sobre un secret
 * que nunca se configuró se resuelve como `''`, no como ausente — la env var
 * SÍ existe en el proceso, solo que vacía. `process.env.X ?? default` nunca
 * dispara en ese caso porque `??` solo reemplaza `null`/`undefined`, y el
 * pipeline queda pidiéndole a OpenCode Go el modelo `''`.
 *
 * Confirmado en producción: sin este chequeo, las ~45 corridas por medio
 * fallaron con "401 Model  is not supported" (nombre vacío, doble espacio)
 * en la primera corrida real tras destrabar el sandbox de Chrome.
 */
export function envOverride(valor: string | undefined, porDefecto: string): string {
  const limpio = valor?.trim()
  return limpio ? limpio : porDefecto
}

// Los IDs salen del catálogo público https://opencode.ai/zen/go/v1/models y son
// overridables por env var a propósito: si Go renombra o discontinúa un modelo
// se corrige cambiando una variable, sin tocar código ni redeployar.
const MODELO_ECONOMICO = envOverride(process.env.OPENCODE_MODELO_ECONOMICO, 'deepseek-v4-flash')
const MODELO_PRECISO = envOverride(process.env.OPENCODE_MODELO_PRECISO, 'deepseek-v4-pro')

export const PERFILES_MODELO: Record<PerfilModelo, ConfigModelo> = {
  economico: {
    proveedor: 'opencode',
    modelo: MODELO_ECONOMICO,
    baseUrl: OPENCODE_BASE_URL,
    descripcion: `OpenCode Go · ${MODELO_ECONOMICO} — costo mínimo`,
    costoPorMilTokens: 0.00014, // deepseek-v4-flash: USD 0.14 por 1M de entrada
  },
  preciso: {
    proveedor: 'opencode',
    modelo: MODELO_PRECISO,
    baseUrl: OPENCODE_BASE_URL,
    descripcion: `OpenCode Go · ${MODELO_PRECISO} — mayor precisión`,
    costoPorMilTokens: 0.000435, // deepseek-v4-pro: USD 0.435 por 1M de entrada
  },
  // Perfil de respaldo: si Go se cae o un modelo deja de responder como se
  // espera, se vuelve al proveedor anterior con PIPELINE_PERFIL_MODELO=openrouter
  // sin necesidad de deploy.
  openrouter: {
    proveedor: 'openrouter',
    modelo: envOverride(process.env.OPENROUTER_MODEL, 'deepseek/deepseek-chat-v3-0324'),
    baseUrl: 'https://openrouter.ai/api/v1',
    descripcion: 'OpenRouter · DeepSeek V3 — respaldo',
    costoPorMilTokens: 0.00014,
  },
  local: {
    proveedor: 'ollama',
    modelo: envOverride(process.env.OLLAMA_MODEL, 'llama3.1:8b'),
    baseUrl: envOverride(process.env.OLLAMA_BASE_URL, 'http://localhost:11434'),
    descripcion: 'Modelo local Ollama — costo cero',
    costoPorMilTokens: 0,
  },
}

export function esPerfilValido(valor: string | undefined | null): valor is PerfilModelo {
  return valor === 'economico' || valor === 'preciso' || valor === 'openrouter' || valor === 'local'
}

/**
 * Perfil impuesto en tiempo de ejecución, por encima de PIPELINE_PERFIL_MODELO.
 *
 * Lo usa el pipeline cuando el perfil principal no pasa la verificación inicial
 * y hay un respaldo con credenciales: la corrida sigue con el respaldo en vez de
 * morir. Vive en memoria del proceso a propósito — no se escribe en process.env
 * para que un test o una corrida siguiente no hereden el cambio sin querer.
 */
let perfilForzado: PerfilModelo | null = null

/** `null` vuelve a respetar PIPELINE_PERFIL_MODELO. */
export function forzarPerfil(perfil: PerfilModelo | null): void {
  perfilForzado = perfil
}

export function getPerfilActivo(): PerfilModelo {
  if (perfilForzado) return perfilForzado
  const perfil = process.env.PIPELINE_PERFIL_MODELO
  return esPerfilValido(perfil) ? perfil : 'economico'
}

export function getConfigActiva(): ConfigModelo {
  return PERFILES_MODELO[getPerfilActivo()]
}

/**
 * Perfil de respaldo configurado, sin mirar credenciales (eso lo decide
 * cliente-llm.ts, que es el único que sabe qué env var usa cada proveedor).
 *
 * PIPELINE_PERFIL_RESPALDO manda si está seteado. Si no, se ofrece
 * 'openrouter', que es el respaldo histórico: si no tiene key, quien llama lo
 * descarta. Nunca devuelve el mismo perfil que está activo.
 */
export function getPerfilRespaldoConfigurado(env: Record<string, string | undefined> = process.env): PerfilModelo | null {
  const explicito = env.PIPELINE_PERFIL_RESPALDO?.trim()
  const candidato: PerfilModelo | null = explicito
    ? (esPerfilValido(explicito) ? explicito : null)
    : 'openrouter'
  return candidato && candidato !== getPerfilActivo() ? candidato : null
}

/**
 * Cuánto "piensa" el modelo antes de responder.
 *
 * deepseek-v4-flash es un modelo de razonamiento con esfuerzo alto por defecto.
 * En la última corrida sana (06/09/2026) una identificación que devolvía ~1.000
 * caracteres llegó a gastar 13.190 tokens de salida y entre 3 y 6 minutos: 40
 * de los 70 minutos de la corrida fueron el LLM pensando. Para clasificar una
 * nota y devolver un JSON eso sobra.
 *
 * Es opt-in y NO tiene default: el parámetro depende del proveedor
 * (`reasoning_effort` es de la API de OpenAI; `thinking` es propio de DeepSeek)
 * y no se pudo probar contra OpenCode Go sin key. Vacío = no se manda nada y
 * decide el proveedor, que es el comportamiento que ya se sabe que funciona. Si
 * el proveedor rechaza el parámetro, la verificación inicial del pipeline lo
 * detecta y sigue sin él (ver verificarProveedorLLM en cliente-llm.ts).
 */
export type NivelRazonamiento = 'desactivado' | 'bajo' | 'alto' | 'max'

export function getNivelRazonamiento(env: Record<string, string | undefined> = process.env): NivelRazonamiento | null {
  const valor = env.PIPELINE_LLM_RAZONAMIENTO?.trim().toLowerCase()
  if (valor === 'desactivado' || valor === 'bajo' || valor === 'alto' || valor === 'max') return valor
  return null
}
