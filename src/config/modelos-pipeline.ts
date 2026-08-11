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

export function getPerfilActivo(): PerfilModelo {
  const perfil = process.env.PIPELINE_PERFIL_MODELO
  if (perfil === 'preciso' || perfil === 'local' || perfil === 'openrouter') return perfil
  return 'economico'
}

export function getConfigActiva(): ConfigModelo {
  return PERFILES_MODELO[getPerfilActivo()]
}
