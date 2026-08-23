/**
 * `npm run llm:probar` — manda un request mínimo real a cada motor LLM
 * configurado y reporta latencia, si respetó el formato JSON pedido, costo
 * estimado y el error exacto si falló.
 *
 * POR QUÉ EXISTE
 * Sin esto, "enchufar" un proveedor nuevo (agregar una entrada al JSON con
 * su modelo y su env var) implica correr el pipeline completo contra medios
 * reales y esperar 40 minutos para enterarse de que el modelo no existe, la
 * key es la de otro proveedor, o el protocolo elegido está mal. Con esto:
 * dos minutos, un request cada uno, y el error real (no una respuesta vacía
 * sin contexto).
 *
 * SIN API KEYS, NO EXPLOTA
 * Un motor sin su env var seteada (o seteada como '', el caso de un secret
 * de GitHub Actions nunca configurado) se reporta como "salteado", no como
 * error — igual que en la corrida real.
 *
 * Se prueban tanto los motores del JSON (`config/motores-llm.json` o
 * `LLM_MOTORES`) como el motor legacy activo (`PIPELINE_PERFIL_MODELO`), para
 * cubrir los dos caminos que hoy conviven.
 */

import 'dotenv/config'
import {
  getMotoresConfigurados,
  motorLegacyActivo,
  motorDisponible,
  credencialFaltanteDeMotor,
  type MotorLLMConfig,
} from '../../src/config/motores-llm'
import { completarConMotor } from '../../src/lib/mapa/cliente-llm'
import { parsearJsonLLM } from '../../src/lib/pipeline/schemas-llm'

interface ResultadoProbe {
  id: string
  estado: 'ok' | 'salteado' | 'error'
  latenciaMs?: number
  respetoFormato?: boolean
  costoEstimadoUsd?: number
  detalle: string
}

const SYSTEM_PROBE = 'Respondé exclusivamente con JSON, sin texto adicional ni backticks.'
const USER_PROBE = 'Devolvé exactamente este objeto JSON, sin cambiar nada: {"ok": true}'

async function probarMotor(motor: MotorLLMConfig): Promise<ResultadoProbe> {
  if (!motorDisponible(motor)) {
    const envVar = credencialFaltanteDeMotor(motor)
    return {
      id: motor.id,
      estado: 'salteado',
      detalle: envVar ? `falta ${envVar}` : 'sin credencial',
    }
  }

  const inicio = Date.now()
  try {
    const respuesta = await completarConMotor(motor, {
      system: SYSTEM_PROBE,
      mensajes: [{ role: 'user', content: USER_PROBE }],
      max_tokens: 50,
      temperature: 0,
    })
    const latenciaMs = Date.now() - inicio
    const contenido = respuesta.choices[0]?.message.content ?? ''
    const parseado = parsearJsonLLM(contenido)
    const respetoFormato = parseado.ok && typeof parseado.valor === 'object' && parseado.valor !== null

    const tokensEntrada = respuesta.usage?.prompt_tokens ?? 0
    const costoEstimadoUsd = (tokensEntrada / 1000) * motor.costoEntradaPorMil

    return {
      id: motor.id,
      estado: 'ok',
      latenciaMs,
      respetoFormato,
      costoEstimadoUsd,
      detalle: respetoFormato
        ? `respondió en ${latenciaMs}ms — ${contenido.slice(0, 80)}`
        : `respondió pero no en el formato pedido — crudo: ${contenido.slice(0, 120)}`,
    }
  } catch (error) {
    return {
      id: motor.id,
      estado: 'error',
      latenciaMs: Date.now() - inicio,
      detalle: error instanceof Error ? error.message : String(error),
    }
  }
}

function motoresAProbar(): MotorLLMConfig[] {
  const configurados = getMotoresConfigurados()
  const legacy = motorLegacyActivo()
  // El legacy va primero: es el motor que usa la corrida real hoy mismo.
  const vistos = new Set([legacy.id])
  const resto = configurados.filter(m => !vistos.has(m.id))
  return [legacy, ...resto]
}

function formatearLinea(r: ResultadoProbe): string {
  if (r.estado === 'salteado') return `⏭️  ${r.id.padEnd(24)} salteado — ${r.detalle}`
  if (r.estado === 'error') return `❌ ${r.id.padEnd(24)} error tras ${r.latenciaMs}ms — ${r.detalle}`
  const formato = r.respetoFormato ? 'JSON ok' : 'JSON MAL FORMADO'
  const costo = r.costoEstimadoUsd !== undefined ? `~US$${r.costoEstimadoUsd.toFixed(6)}` : 's/d'
  return `✅ ${r.id.padEnd(24)} ${r.latenciaMs}ms — ${formato} — costo estimado ${costo}`
}

async function main() {
  const motores = motoresAProbar()
  console.log(`Probando ${motores.length} motor(es)...\n`)

  const resultados: ResultadoProbe[] = []
  for (const motor of motores) {
    // Secuencial, no paralelo: el objetivo es un diagnóstico legible, no
    // throughput — y evita que un rate limit de un proveedor contamine la
    // lectura de otro.
    const r = await probarMotor(motor)
    resultados.push(r)
    console.log(formatearLinea(r))
  }

  const ok = resultados.filter(r => r.estado === 'ok').length
  const salteados = resultados.filter(r => r.estado === 'salteado').length
  const errores = resultados.filter(r => r.estado === 'error').length
  console.log(`\n${ok} ok · ${salteados} salteado(s) · ${errores} error(es)`)

  if (errores > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('probar-motores: fallo inesperado', error)
  process.exitCode = 1
})
