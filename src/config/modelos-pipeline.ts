export type PerfilModelo = 'economico' | 'preciso' | 'local'

export interface ConfigModelo {
  proveedor: 'openrouter' | 'ollama'
  modelo: string
  baseUrl: string
  descripcion: string
  costoPorMilTokens: number
}

export const PERFILES_MODELO: Record<PerfilModelo, ConfigModelo> = {
  economico: {
    proveedor: 'openrouter',
    modelo: 'deepseek/deepseek-chat-v3-0324',
    baseUrl: 'https://openrouter.ai/api/v1',
    descripcion: 'DeepSeek V3 — costo mínimo',
    costoPorMilTokens: 0.00014,
  },
  preciso: {
    proveedor: 'openrouter',
    modelo: 'anthropic/claude-3-haiku-20240307',
    baseUrl: 'https://openrouter.ai/api/v1',
    descripcion: 'Claude Haiku — mayor precisión',
    costoPorMilTokens: 0.00025,
  },
  local: {
    proveedor: 'ollama',
    modelo: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    descripcion: 'Modelo local Ollama — costo cero',
    costoPorMilTokens: 0,
  },
}

export function getPerfilActivo(): PerfilModelo {
  const perfil = process.env.PIPELINE_PERFIL_MODELO
  if (perfil === 'preciso' || perfil === 'local') return perfil
  return 'economico'
}

export function getConfigActiva(): ConfigModelo {
  return PERFILES_MODELO[getPerfilActivo()]
}
