/**
 * Observabilidad y reintentos de las llamadas al LLM.
 *
 * EL DEFECTO
 * El pipeline descartaba casi todo lo que encontraba (23 de 24 noticias el
 * 19/8) y era imposible saber por qué: ante una respuesta vacía o un JSON
 * cortado, los logs no registraban `finish_reason`, ni `usage`, ni el contenido
 * crudo, ni siquiera la URL de la noticia. Y no había ningún reintento — los
 * `maxRetries: 2` de la SDK de OpenAI cubren errores de conexión y 4xx/5xx,
 * pero un 200 con cuerpo vacío o truncado no se reintenta nunca, así que cada
 * blip descartaba la noticia para siempre.
 *
 * Los cortes eran en las posiciones 37/207/214 (~60 tokens) con max_tokens 500
 * y 800 — el de 800 se cortaba en la misma posición 207. O sea que el límite de
 * tokens no era la causa, y para distinguir entre "modelo de razonamiento que
 * deja content vacío" y "gateway que corta la respuesta" hace falta justamente
 * lo que no se registraba.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  diagnosticar,
  formatearDiagnostico,
  obtenerContenidoLLM,
  MAX_CHARS_LOG,
} from '../../src/lib/pipeline/llamada-llm'

/** Respuesta con la forma que devuelve la API de OpenAI. */
function respuesta(
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return { choices: [{ finish_reason: 'stop', message }], ...extra }
}

describe('diagnosticar', () => {
  test('extrae contenido, finish_reason y usage', () => {
    const d = diagnosticar(
      respuesta({ role: 'assistant', content: '{"ok":true}' }, { usage: { total_tokens: 42 } })
    )
    assert.equal(d.contenido, '{"ok":true}')
    assert.equal(d.finishReason, 'stop')
    assert.deepEqual(d.usage, { total_tokens: 42 })
    assert.equal(d.vacio, false)
  })

  test('detecta la respuesta vacía y la de solo espacios', () => {
    assert.equal(diagnosticar(respuesta({ content: '' })).vacio, true)
    assert.equal(diagnosticar(respuesta({ content: '   \n ' })).vacio, true)
    assert.equal(diagnosticar(respuesta({ content: null })).vacio, true)
  })

  test('detecta reasoning_content — la hipótesis principal del fallo', () => {
    // Si el proveedor manda el razonamiento aparte y deja content vacío, esto
    // es lo único que lo delata. Antes no se miraba: el código leía solo
    // `.content` y reportaba "respuesta vacía" sin más.
    const d = diagnosticar(
      respuesta({ role: 'assistant', content: '', reasoning_content: 'pensando…' })
    )
    assert.equal(d.vacio, true)
    assert.deepEqual(d.camposNoEstandar, ['reasoning_content'])
  })

  test('no marca como no estándar los campos que sí lo son', () => {
    const d = diagnosticar(
      respuesta({ role: 'assistant', content: 'x', refusal: null, tool_calls: [] })
    )
    assert.deepEqual(d.camposNoEstandar, [])
  })

  test('registra finish_reason=length, que indicaría corte por tokens', () => {
    const d = diagnosticar({
      choices: [{ finish_reason: 'length', message: { content: '{"a":' } }],
    })
    assert.equal(d.finishReason, 'length')
    assert.equal(d.largoContenido, 5)
  })

  test('no explota con respuestas deformes', () => {
    for (const basura of [null, undefined, {}, { choices: [] }, { choices: [{}] }, 42, 'x']) {
      const d = diagnosticar(basura)
      assert.equal(d.vacio, true)
      assert.equal(d.finishReason, null)
    }
  })
})

describe('formatearDiagnostico', () => {
  test('incluye la etiqueta, que antes faltaba en el log de vacío', () => {
    const d = diagnosticar(respuesta({ content: '' }))
    assert.match(formatearDiagnostico(d, 'https://medio/nota'), /https:\/\/medio\/nota/)
  })

  test('incluye finish_reason y el largo', () => {
    const linea = formatearDiagnostico(diagnosticar(respuesta({ content: 'hola' })), 'x')
    assert.match(linea, /finish_reason=stop/)
    assert.match(linea, /largo_contenido=4/)
  })

  test('recorta el contenido crudo para no inundar los logs', () => {
    const largo = 'a'.repeat(MAX_CHARS_LOG * 3)
    const linea = formatearDiagnostico(diagnosticar(respuesta({ content: largo })), 'x')
    assert.ok(linea.length < MAX_CHARS_LOG * 2, 'la línea de log no debería crecer sin límite')
    assert.match(linea, /…/, 'debería marcar que se recortó')
  })

  test('destaca los campos no estándar cuando existen', () => {
    const d = diagnosticar(respuesta({ content: '', reasoning_content: 'x' }))
    assert.match(formatearDiagnostico(d, 'x'), /campos_no_estandar=\[reasoning_content\]/)
  })
})

describe('obtenerContenidoLLM', () => {
  /** Espías para no esperar de verdad ni ensuciar la salida. */
  function espias() {
    const logs: string[] = []
    const esperas: number[] = []
    return {
      logs,
      esperas,
      registrar: (m: string) => logs.push(m),
      dormir: async (ms: number) => { esperas.push(ms) },
    }
  }

  test('devuelve el contenido en el primer intento cuando anda', async () => {
    const e = espias()
    let llamadas = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => { llamadas++; return respuesta({ content: '{"ok":1}' }) },
      etiqueta: 'x', ...e,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.contenido, '{"ok":1}')
    assert.equal(llamadas, 1)
    assert.deepEqual(e.esperas, [], 'no debería esperar si salió bien de una')
  })

  test('reintenta ante respuesta vacía y devuelve el contenido del segundo intento', async () => {
    // Este es el caso central: antes una respuesta vacía descartaba la noticia
    // para siempre, sin segundo intento.
    const e = espias()
    const salidas = [respuesta({ content: '' }), respuesta({ content: 'bien' })]
    let i = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => salidas[i++],
      etiqueta: 'https://medio/nota', ...e,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.contenido, 'bien')
    assert.equal(r.intentos, 2)
    assert.equal(e.esperas.length, 1, 'debería haber esperado una vez')
  })

  test('reintenta cuando el contenido no pasa el validador (JSON cortado)', async () => {
    const e = espias()
    const salidas = [
      respuesta({ content: '{"esHechoDelictivo": true, "provi' }), // truncado
      respuesta({ content: '{"esHechoDelictivo": true}' }),
    ]
    let i = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => salidas[i++],
      etiqueta: 'x',
      aceptar: c => { try { JSON.parse(c); return true } catch { return false } },
      ...e,
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.intentos, 2)
  })

  test('reintenta ante excepción del proveedor', async () => {
    const e = espias()
    let i = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => {
        if (i++ === 0) throw new Error('socket hang up')
        return respuesta({ content: 'ok' })
      },
      etiqueta: 'x', ...e,
    })
    assert.equal(r.ok, true)
    assert.match(e.logs.join('\n'), /socket hang up/)
  })

  test('se rinde después de agotar los intentos y explica por qué', async () => {
    const e = espias()
    let llamadas = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => { llamadas++; return respuesta({ content: '' }) },
      etiqueta: 'x', intentos: 3, ...e,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.motivo, 'respuesta vacía')
    assert.equal(r.intentos, 3)
    assert.equal(llamadas, 3)
    assert.equal(e.esperas.length, 2, 'espera entre intentos, no después del último')
  })

  test('el backoff crece', async () => {
    const e = espias()
    await obtenerContenidoLLM({
      ejecutar: async () => respuesta({ content: '' }),
      etiqueta: 'x', intentos: 4, ...e,
    })
    assert.deepEqual(e.esperas, [500, 1000, 1500])
    for (let i = 1; i < e.esperas.length; i++) {
      assert.ok(e.esperas[i] > e.esperas[i - 1], 'cada espera debería ser mayor')
    }
  })

  test('cada intento fallido deja su diagnóstico en el log', async () => {
    // El punto de todo el módulo: que se pueda ver el patrón en los logs de una
    // corrida real. Si todos los intentos traen finish_reason=length, o usage
    // con muchos tokens de salida y contenido vacío, ahí está la respuesta.
    const e = espias()
    await obtenerContenidoLLM({
      ejecutar: async () => ({
        choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'x' } }],
        usage: { completion_tokens: 500 },
      }),
      etiqueta: 'https://medio/nota', intentos: 2, ...e,
    })
    const log = e.logs.join('\n')
    assert.match(log, /finish_reason=length/)
    assert.match(log, /completion_tokens/)
    assert.match(log, /campos_no_estandar=\[reasoning_content\]/)
    assert.match(log, /https:\/\/medio\/nota/)
    assert.match(log, /intento 1\/2/)
    assert.match(log, /intento 2\/2/)
  })

  test('avisa cuando un reintento salva la noticia', async () => {
    const e = espias()
    const salidas = [respuesta({ content: '' }), respuesta({ content: 'ok' })]
    let i = 0
    await obtenerContenidoLLM({ ejecutar: async () => salidas[i++], etiqueta: 'x', ...e })
    assert.match(e.logs.join('\n'), /resuelto en el intento 2\/3/)
  })

  test('con intentos: 1 no reintenta', async () => {
    const e = espias()
    let llamadas = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => { llamadas++; return respuesta({ content: '' }) },
      etiqueta: 'x', intentos: 1, ...e,
    })
    assert.equal(r.ok, false)
    assert.equal(llamadas, 1)
    assert.deepEqual(e.esperas, [])
  })

  describe('escalada entre motores', () => {
    // EL DEFECTO REAL: el 20/8 Diario Popular se perdió entero porque los
    // tres intentos pegaron contra el mismo OpenCode Go y los tres dieron
    // 500. Sin `motores`, un reintento nunca puede evitar un proveedor caído
    // — vuelve a pegarle exactamente al mismo. Con `motores`, el intento que
    // sigue a un fallo tiene que salir por el SIGUIENTE de la lista.

    test('tras un fallo, el siguiente intento sale por el motor siguiente, no por el mismo', async () => {
      const e = espias()
      const motoresUsados: Array<string | undefined> = []
      const r = await obtenerContenidoLLM({
        motores: [{ id: 'motor-a' }, { id: 'motor-b' }],
        ejecutar: async motor => {
          motoresUsados.push(motor?.id)
          if (motor?.id === 'motor-a') throw new Error('500 de motor-a')
          return respuesta({ content: 'ok' })
        },
        etiqueta: 'x', ...e,
      })
      assert.equal(r.ok, true)
      assert.deepEqual(motoresUsados, ['motor-a', 'motor-b'], 'el segundo intento tiene que haber salido por motor-b, no por motor-a otra vez')
    })

    test('sin `motores`, ejecutar() recibe undefined y el comportamiento es idéntico al de antes', async () => {
      // Los tres consumidores que todavía no migraron (scrapear-medios.ts
      // entre ellos) pasan una función de cero argumentos. Este test es la
      // garantía de que agregar el parámetro no les cambió nada.
      const e = espias()
      const argumentosRecibidos: unknown[] = []
      let llamadas = 0
      const r = await obtenerContenidoLLM({
        ejecutar: async (motor) => {
          argumentosRecibidos.push(motor)
          llamadas++
          return respuesta({ content: 'ok' })
        },
        etiqueta: 'x', ...e,
      })
      assert.equal(r.ok, true)
      assert.equal(llamadas, 1)
      assert.deepEqual(argumentosRecibidos, [undefined])
    })

    test('el log de cada intento fallido incluye a qué motor le tocó', async () => {
      const e = espias()
      await obtenerContenidoLLM({
        motores: [{ id: 'motor-a' }, { id: 'motor-b' }],
        ejecutar: async () => respuesta({ content: '' }),
        etiqueta: 'x', ...e,
      })
      const log = e.logs.join('\n')
      assert.match(log, /motor=motor-a/)
      assert.match(log, /motor=motor-b/)
    })

    test('con más intentos que motores, el ciclo vuelve a empezar desde el primero', async () => {
      const e = espias()
      const motoresUsados: Array<string | undefined> = []
      await obtenerContenidoLLM({
        motores: [{ id: 'motor-a' }, { id: 'motor-b' }],
        intentos: 4,
        ejecutar: async motor => {
          motoresUsados.push(motor?.id)
          return respuesta({ content: '' })
        },
        etiqueta: 'x', ...e,
      })
      assert.deepEqual(motoresUsados, ['motor-a', 'motor-b', 'motor-a', 'motor-b'])
    })

    test('el default de `intentos` es la cantidad de motores, no 3', async () => {
      const e = espias()
      let llamadas = 0
      const r = await obtenerContenidoLLM({
        motores: [{ id: 'a' }, { id: 'b' }],
        ejecutar: async () => { llamadas++; return respuesta({ content: '' }) },
        etiqueta: 'x', ...e,
      })
      assert.equal(r.ok, false)
      if (r.ok) return
      assert.equal(r.intentos, 2)
      assert.equal(llamadas, 2)
    })
  })
})
