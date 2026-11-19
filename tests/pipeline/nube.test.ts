import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { agenteDisponible, despertarAgenteNube, AGENTE_BAJO_DEMANDA_VIVO_MS } from '../../src/lib/pipeline/nube'
import { AGENTE_VIVO_MS } from '../../src/lib/pipeline/corridas'

const AHORA = Date.parse('2026-11-19T15:00:00Z')
const hace = (ms: number) => new Date(AHORA - ms)

describe('agenteDisponible', () => {
  test('el agente de la computadora se desconecta a los pocos minutos sin latido', () => {
    assert.equal(agenteDisponible({ latidoAt: hace(AGENTE_VIVO_MS - 1000), info: {} }, AHORA), true)
    assert.equal(agenteDisponible({ latidoAt: hace(AGENTE_VIVO_MS + 1000), info: {} }, AHORA), false)
  })

  test('el agente bajo demanda sigue disponible horas después de su última corrida', () => {
    const info = { bajoDemanda: true }
    assert.equal(agenteDisponible({ latidoAt: hace(10 * 60 * 60 * 1000), info }, AHORA), true)
    assert.equal(agenteDisponible({ latidoAt: hace(AGENTE_BAJO_DEMANDA_VIVO_MS + 1000), info }, AHORA), false)
  })

  test('info inválida se trata como agente común', () => {
    for (const info of [null, 'x', { bajoDemanda: 'true' }]) {
      assert.equal(agenteDisponible({ latidoAt: hace(60 * 60 * 1000), info }, AHORA), false)
    }
  })
})

describe('despertarAgenteNube', () => {
  test('sin URL o token no llama a nada', async () => {
    let llamadas = 0
    const f = (async () => { llamadas++; return new Response() }) as typeof fetch
    assert.deepEqual(await despertarAgenteNube({}, f), { estado: 'sin-configurar' })
    assert.deepEqual(await despertarAgenteNube({ PIPELINE_NUBE_URL: 'https://x.dev' }, f), { estado: 'sin-configurar' })
    assert.equal(llamadas, 0)
  })

  test('hace POST /despertar con el token y devuelve el estado del Worker', async () => {
    let pedido: { url: string; init?: RequestInit } | null = null
    const f = (async (url: URL, init?: RequestInit) => {
      pedido = { url: String(url), init }
      return Response.json({ estado: 'encendido', motivo: 'panel' })
    }) as unknown as typeof fetch
    const r = await despertarAgenteNube({ PIPELINE_NUBE_URL: 'https://w.example.workers.dev/', PIPELINE_NUBE_TOKEN: 'secreto' }, f)
    assert.deepEqual(r, { estado: 'encendido' })
    assert.equal(pedido!.url, 'https://w.example.workers.dev/despertar')
    assert.equal(pedido!.init?.method, 'POST')
    assert.equal((pedido!.init?.headers as Record<string, string>).Authorization, 'Bearer secreto')
  })

  test('un error de red o HTTP no lanza: devuelve error', async () => {
    const env = { PIPELINE_NUBE_URL: 'https://w.dev', PIPELINE_NUBE_TOKEN: 't' }
    const caido = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    assert.equal((await despertarAgenteNube(env, caido)).estado, 'error')
    const no = (async () => new Response('no', { status: 401 })) as typeof fetch
    assert.deepEqual(await despertarAgenteNube(env, no), { estado: 'error', detalle: 'HTTP 401' })
  })
})
