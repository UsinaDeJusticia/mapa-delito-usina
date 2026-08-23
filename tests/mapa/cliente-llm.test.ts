/**
 * Adaptador de protocolo Anthropic en el cliente LLM multi-motor.
 *
 * POR QUÉ HACE FALTA UN ADAPTADOR APARTE
 * La API de Claude no es compatible con la de OpenAI (verificado, no
 * supuesto): `system` va como parámetro top-level, no como un mensaje con
 * `role: "system"`; el contenido de la respuesta llega en bloques
 * (`content: [{type:"text", text:"..."}]`); y el consumo se reporta como
 * `usage.input_tokens` / `usage.output_tokens`, no `prompt_tokens` /
 * `completion_tokens` como el resto del pipeline espera.
 *
 * Estos tests prueban la traducción en las dos puntas SIN pegarle a la red:
 * `armarRequestAnthropic` (params genéricos → request del SDK) y
 * `normalizarRespuestaAnthropic` (respuesta del SDK → forma tipo-OpenAI que
 * `diagnosticar()` en llamada-llm.ts ya sabe leer). Si esta traducción
 * estuviera mal, un motor `protocolo: "anthropic"` respondería con
 * `finish_reason`/`usage` con nombres que el resto del sistema no entiende, y
 * el fallo se vería como "respuesta vacía" sin ninguna pista de la causa real.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  armarRequestAnthropic,
  normalizarRespuestaAnthropic,
} from '../../src/lib/mapa/cliente-llm'

describe('armarRequestAnthropic', () => {
  test('el system sale de los mensajes y va como parámetro aparte', () => {
    const req = armarRequestAnthropic(
      { modelo: 'claude-haiku-4-5' },
      {
        system: 'Sos un analista forense.',
        mensajes: [{ role: 'user', content: 'hola' }],
        max_tokens: 500,
      }
    )
    assert.equal(req.system, 'Sos un analista forense.')
    assert.deepEqual(req.messages, [{ role: 'user', content: 'hola' }])
    // Ninguno de los mensajes puede llevar role:"system" — esa API no lo acepta.
    assert.ok(!req.messages.some((m: { role: string }) => m.role === 'system'))
  })

  test('max_tokens es obligatorio y se traslada tal cual', () => {
    const req = armarRequestAnthropic(
      { modelo: 'claude-haiku-4-5' },
      { system: 'x', mensajes: [], max_tokens: 1234 }
    )
    assert.equal(req.max_tokens, 1234)
  })

  test('preserva los mensajes few-shot user/assistant en orden', () => {
    const req = armarRequestAnthropic(
      { modelo: 'claude-haiku-4-5' },
      {
        system: 'x',
        mensajes: [
          { role: 'user', content: 'ejemplo 1' },
          { role: 'assistant', content: '{"ok":true}' },
          { role: 'user', content: 'noticia real' },
        ],
        max_tokens: 100,
      }
    )
    assert.equal(req.messages.length, 3)
    assert.equal(req.messages[1].role, 'assistant')
  })
})

describe('normalizarRespuestaAnthropic', () => {
  test('junta los bloques de texto en un solo string de contenido', () => {
    const r = normalizarRespuestaAnthropic({
      content: [
        { type: 'text', text: '{"esHechoDelictivo"' } as any,
        { type: 'text', text: ':true}' } as any,
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20 } as any,
    })
    assert.equal(r.choices[0].message.content, '{"esHechoDelictivo":true}')
  })

  test('ignora bloques que no son de texto (ej. tool_use)', () => {
    const r = normalizarRespuestaAnthropic({
      content: [
        { type: 'tool_use', id: 't1', name: 'x', input: {} } as any,
        { type: 'text', text: 'solo esto cuenta' } as any,
      ],
      stop_reason: 'end_turn',
      usage: null as any,
    })
    assert.equal(r.choices[0].message.content, 'solo esto cuenta')
  })

  test('traduce usage: input_tokens/output_tokens → prompt_tokens/completion_tokens', () => {
    const r = normalizarRespuestaAnthropic({
      content: [{ type: 'text', text: 'x' } as any],
      stop_reason: 'end_turn',
      usage: { input_tokens: 321, output_tokens: 45 } as any,
    })
    assert.deepEqual(r.usage, { prompt_tokens: 321, completion_tokens: 45 })
  })

  test('usage ausente se traduce a null, no a un objeto con NaN', () => {
    const r = normalizarRespuestaAnthropic({
      content: [{ type: 'text', text: 'x' } as any],
      stop_reason: 'end_turn',
      usage: undefined as any,
    })
    assert.equal(r.usage, null)
  })

  test('stop_reason se traslada como finish_reason', () => {
    const r = normalizarRespuestaAnthropic({
      content: [{ type: 'text', text: 'x' } as any],
      stop_reason: 'max_tokens',
      usage: null as any,
    })
    assert.equal(r.choices[0].finish_reason, 'max_tokens')
  })

  test('la forma de salida es la que diagnosticar() de llamada-llm.ts ya sabe leer', async () => {
    const { diagnosticar } = await import('../../src/lib/pipeline/llamada-llm')
    const r = normalizarRespuestaAnthropic({
      content: [{ type: 'text', text: '{"ok":1}' } as any],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 } as any,
    })
    const d = diagnosticar(r)
    assert.equal(d.contenido, '{"ok":1}')
    assert.equal(d.finishReason, 'end_turn')
    assert.equal(d.vacio, false)
  })
})
