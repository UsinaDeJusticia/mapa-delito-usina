/**
 * El cliente LLM manda lo que OpenCode Go exige desde el 06/09/2026.
 *
 * Regresión real: del 7 al 24/9 todas las corridas fallaron con
 *   400 Request is missing x-opencode-session and cannot be routed efficiently
 * y terminaron en verde con cero noticias. Estos tests miran la request que de
 * verdad sale por la red (fetch inyectado en el SDK), no la configuración.
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  crearClienteLLM,
  headersPara,
  idSesionLLM,
  parametrosExtraLLM,
  verificarProveedorLLM,
  perfilRespaldoDisponible,
  HEADER_SESION_OPENCODE,
  USER_AGENT_PIPELINE,
} from '../../src/lib/mapa/cliente-llm'
import { PERFILES_MODELO, forzarPerfil } from '../../src/config/modelos-pipeline'

interface Capturada {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

/** fetch falso: guarda cada request y responde lo que diga `responder`. */
function fetchFalso(responder: (body: Record<string, unknown>, n: number) => Response) {
  const capturadas: Capturada[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    capturadas.push({ url: String(input), headers: new Headers(init?.headers), body })
    return responder(body, capturadas.length)
  }) as typeof globalThis.fetch
  return { fetch, capturadas }
}

const OK = () =>
  new Response(
    JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'deepseek-v4-flash',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const ERROR = (status: number, mensaje: string) =>
  new Response(JSON.stringify({ error: { message: mensaje } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const ENV_ORIGINAL = { ...process.env }

beforeEach(() => {
  process.env.OPENCODE_API_KEY = 'clave-de-prueba'
  process.env.PIPELINE_PERFIL_MODELO = 'economico'
  delete process.env.PIPELINE_LLM_RAZONAMIENTO
  delete process.env.OPENROUTER_API_KEY
  delete process.env.PIPELINE_PERFIL_RESPALDO
  forzarPerfil(null)
})

afterEach(() => {
  process.env = { ...ENV_ORIGINAL }
  forzarPerfil(null)
})

describe('headers de OpenCode Go', () => {
  test('cada request lleva x-opencode-session y un User-Agent propio', async () => {
    const { fetch, capturadas } = fetchFalso(() => OK())
    const { cliente, config } = crearClienteLLM('Consumidor A', { fetch })
    await cliente.chat.completions.create({ model: config.modelo, messages: [{ role: 'user', content: 'hola' }] })

    assert.equal(capturadas.length, 1)
    const h = capturadas[0].headers
    assert.ok(h.get(HEADER_SESION_OPENCODE), 'falta x-opencode-session: OpenCode Go responde 400')
    assert.equal(h.get('user-agent'), USER_AGENT_PIPELINE, 'Go pide un user agent propio, no el genérico del SDK')
    assert.match(capturadas[0].url, /opencode\.ai\/zen\/go\/v1\/chat\/completions$/)
  })

  test('la sesión es estable por consumidor y distinta entre consumidores', async () => {
    const { fetch, capturadas } = fetchFalso(() => OK())
    for (const consumidor of ['Consumidor B', 'Consumidor B', 'Consumidor C']) {
      const { cliente, config } = crearClienteLLM(consumidor, { fetch })
      await cliente.chat.completions.create({ model: config.modelo, messages: [{ role: 'user', content: 'x' }] })
    }
    const [b1, b2, c] = capturadas.map(r => r.headers.get(HEADER_SESION_OPENCODE))
    assert.equal(b1, b2, 'dos clientes del mismo consumidor deben compartir sesión (caché de prompts)')
    assert.notEqual(b1, c, 'consumidores distintos tienen prompts distintos: sesiones distintas')
    assert.match(b1!, /^[0-9a-f-]{36}$/, 'un UUID')
    assert.equal(idSesionLLM('Consumidor B'), b1)
  })

  test('OpenRouter no recibe el header de Go pero sí su atribución', () => {
    const h = headersPara(PERFILES_MODELO.openrouter, 'Extractor')
    assert.equal(h[HEADER_SESION_OPENCODE], undefined)
    assert.equal(h['X-Title'], 'Extractor')
    assert.equal(h['User-Agent'], USER_AGENT_PIPELINE)
  })
})

describe('parámetros de razonamiento', () => {
  test('sin PIPELINE_LLM_RAZONAMIENTO no se manda nada (comportamiento histórico)', () => {
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.economico), {})
  })

  test('bajo → reasoning_effort low; desactivado → thinking disabled', () => {
    process.env.PIPELINE_LLM_RAZONAMIENTO = 'bajo'
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.economico), { reasoning_effort: 'low' })
    process.env.PIPELINE_LLM_RAZONAMIENTO = 'desactivado'
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.economico), { thinking: { type: 'disabled' } })
  })

  test('un valor desconocido se ignora', () => {
    process.env.PIPELINE_LLM_RAZONAMIENTO = 'muchísimo'
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.economico), {})
  })

  test('Ollama nunca recibe el parámetro', () => {
    process.env.PIPELINE_LLM_RAZONAMIENTO = 'bajo'
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.local), {})
  })
})

describe('verificarProveedorLLM', () => {
  test('ok cuando el proveedor acepta la request', async () => {
    const { fetch } = fetchFalso(() => OK())
    const r = await verificarProveedorLLM({ fetch })
    assert.equal(r.ok, true)
  })

  test('reporta el 400 de sesión faltante con el mensaje del proveedor', async () => {
    const { fetch } = fetchFalso(() =>
      ERROR(400, 'Request is missing x-opencode-session and cannot be routed efficiently.')
    )
    const r = await verificarProveedorLLM({ fetch })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.status, 400)
    assert.match(r.mensaje, /x-opencode-session/)
  })

  test('sin API key falla sin salir a la red', async () => {
    delete process.env.OPENCODE_API_KEY
    const { fetch, capturadas } = fetchFalso(() => OK())
    const r = await verificarProveedorLLM({ fetch })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.mensaje, /OPENCODE_API_KEY/)
    assert.equal(capturadas.length, 0)
  })

  test('si el proveedor rechaza el parámetro de razonamiento, sigue sin él', async () => {
    process.env.PIPELINE_LLM_RAZONAMIENTO = 'desactivado'
    const { fetch, capturadas } = fetchFalso(body =>
      body.thinking ? ERROR(400, 'Unrecognized request argument: thinking') : OK()
    )
    const r = await verificarProveedorLLM({ fetch })
    assert.equal(r.ok, true, 'un parámetro opcional no puede dejar a la corrida sin proveedor')
    assert.ok(r.avisos.some(a => /PIPELINE_LLM_RAZONAMIENTO/.test(a)), 'debe avisar que lo apagó')
    assert.ok(capturadas.some(c => !('thinking' in c.body)), 'debe reintentar sin el parámetro')
    // Y queda apagado para el resto del proceso.
    assert.deepEqual(parametrosExtraLLM(PERFILES_MODELO.economico), {})
  })
})

describe('perfil de respaldo', () => {
  test('sin OPENROUTER_API_KEY no hay respaldo disponible', () => {
    assert.equal(perfilRespaldoDisponible(), null)
  })

  test('con OPENROUTER_API_KEY el respaldo es openrouter', () => {
    process.env.OPENROUTER_API_KEY = 'otra-clave'
    assert.equal(perfilRespaldoDisponible(), 'openrouter')
  })

  test('PIPELINE_PERFIL_RESPALDO=local no necesita credenciales', () => {
    process.env.PIPELINE_PERFIL_RESPALDO = 'local'
    assert.equal(perfilRespaldoDisponible(), 'local')
  })

  test('nunca propone como respaldo el mismo perfil activo', () => {
    process.env.OPENROUTER_API_KEY = 'otra-clave'
    forzarPerfil('openrouter')
    assert.equal(perfilRespaldoDisponible(), null)
  })
})
