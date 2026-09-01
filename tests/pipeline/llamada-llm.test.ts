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
  formatearUso,
  MAX_CHARS_LOG,
  type DiagnosticoLLM,
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
})

describe('registrarUso mide el camino de éxito', () => {
  /**
   * POR QUÉ HACE FALTA
   * El diagnóstico se registraba solo en los intentos fallidos. Servía para
   * encontrar por qué fallaban, pero cuando los fallos bajaron no quedó un solo
   * `prompt_tokens` real con el que decidir cuánto texto mandarle al modelo — y
   * esos recortes son justo donde se pierden femicidios. Medir el éxito es la
   * única forma de elegir esos límites con datos en vez de a ojo.
   */
  function espias() {
    const usos: DiagnosticoLLM[] = []
    return {
      usos,
      registrar: () => {},
      dormir: async () => {},
      registrarUso: (d: DiagnosticoLLM) => usos.push(d),
    }
  }

  test('se llama con el usage del intento que salió bien', async () => {
    const e = espias()
    await obtenerContenidoLLM({
      ejecutar: async () =>
        respuesta({ content: '{"ok":1}' }, { usage: { prompt_tokens: 1200, completion_tokens: 90 } }),
      etiqueta: 'nota', ...e,
    })
    assert.equal(e.usos.length, 1)
    assert.deepEqual(e.usos[0].usage, { prompt_tokens: 1200, completion_tokens: 90 })
  })

  test('NO se llama cuando la llamada termina fallando', async () => {
    // Si se llamara igual, cada fallo dejaría dos líneas de log contradictorias.
    const e = espias()
    const r = await obtenerContenidoLLM({
      ejecutar: async () => respuesta({ content: '' }),
      etiqueta: 'nota', intentos: 2, ...e,
    })
    assert.equal(r.ok, false)
    assert.deepEqual(e.usos, [])
  })

  test('se llama una sola vez, con el intento bueno, cuando hubo reintentos', async () => {
    const e = espias()
    let n = 0
    await obtenerContenidoLLM({
      ejecutar: async () => {
        n++
        return n === 1
          ? respuesta({ content: '' })
          : respuesta({ content: '{"ok":1}' }, { usage: { prompt_tokens: 7 } })
      },
      etiqueta: 'nota', ...e,
    })
    assert.equal(e.usos.length, 1, 'un éxito, una medición')
    assert.deepEqual(e.usos[0].usage, { prompt_tokens: 7 })
  })

  test('sin la opción no se rompe nada: el default es no loguear', async () => {
    // Los consumidores que no la pasan tienen que seguir funcionando igual.
    const r = await obtenerContenidoLLM({
      ejecutar: async () => respuesta({ content: '{"ok":1}' }),
      etiqueta: 'nota', registrar: () => {}, dormir: async () => {},
    })
    assert.equal(r.ok, true)
  })
})

describe('formatearUso', () => {
  test('devuelve null si el proveedor no manda usage', () => {
    // Una línea vacía por nota es peor que ninguna línea.
    const d = diagnosticar(respuesta({ content: 'x' }))
    assert.equal(formatearUso(d, 'nota'), null)
  })

  test('trae el usage y la etiqueta, y NO el contenido crudo', () => {
    // En un éxito el crudo es la extracción completa: loguearla por cada nota
    // taparía justamente lo que se quiere leer.
    const d = diagnosticar(
      respuesta({ content: 'un json larguísimo con datos de la victima' }, { usage: { prompt_tokens: 900 } })
    )
    const linea = formatearUso(d, 'https://medio/nota')!
    assert.match(linea, /prompt_tokens/)
    assert.match(linea, /https:\/\/medio\/nota/)
    assert.ok(!linea.includes('victima'), 'el contenido crudo no debería ir en el log de éxito')
  })
})
