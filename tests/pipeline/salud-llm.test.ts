/**
 * La corrida tiene que darse cuenta cuando el proveedor LLM está caído.
 *
 * Del 7 al 24/9/2026 cada llamada fallaba con un 400 y cada consumidor lo
 * manejaba "bien" de a una noticia; nadie miraba el agregado y el workflow
 * quedó en verde 18 días. Acá se prueba el agregado.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MonitorSaludLLM } from '../../src/lib/pipeline/salud-llm'
import { obtenerContenidoLLM, ESTADOS_NO_REINTENTABLES } from '../../src/lib/pipeline/llamada-llm'

const ERROR_SESION = Object.assign(
  new Error('400 Request is missing x-opencode-session and cannot be routed efficiently.'),
  { status: 400 }
)

const silencio = { registrar: () => {}, dormir: async () => {} }

describe('obtenerContenidoLLM no reintenta lo que no se arregla reintentando', () => {
  test('un 400 corta en el primer intento', async () => {
    let llamadas = 0
    const r = await obtenerContenidoLLM({
      ejecutar: async () => { llamadas++; throw ERROR_SESION },
      etiqueta: 'x', salud: null, ...silencio,
    })
    assert.equal(r.ok, false)
    assert.equal(llamadas, 1, 'antes eran 3 intentos iguales por llamada, todos con el mismo 400')
    if (r.ok) return
    assert.equal(r.errorProveedor?.status, 400)
    assert.match(r.errorProveedor!.mensaje, /x-opencode-session/)
  })

  test('401, 403, 404 y 422 tampoco se reintentan', async () => {
    for (const status of [401, 403, 404, 422]) {
      assert.ok(ESTADOS_NO_REINTENTABLES.has(status))
      let llamadas = 0
      await obtenerContenidoLLM({
        ejecutar: async () => { llamadas++; throw Object.assign(new Error(`${status}`), { status }) },
        etiqueta: 'x', salud: null, ...silencio,
      })
      assert.equal(llamadas, 1, `HTTP ${status}`)
    }
  })

  test('429 y 5xx sí se reintentan', async () => {
    for (const status of [429, 500, 503]) {
      let llamadas = 0
      await obtenerContenidoLLM({
        ejecutar: async () => { llamadas++; throw Object.assign(new Error(`${status}`), { status }) },
        etiqueta: 'x', intentos: 3, salud: null, ...silencio,
      })
      assert.equal(llamadas, 3, `HTTP ${status} suele pasar con un segundo intento`)
    }
  })
})

describe('el resultado de cada llamada llega al monitor', () => {
  test('éxito, fallo de proveedor y fallo de contenido se cuentan por separado', async () => {
    const salud = new MonitorSaludLLM()
    await obtenerContenidoLLM({
      ejecutar: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      etiqueta: 'a', salud, ...silencio,
    })
    await obtenerContenidoLLM({ ejecutar: async () => { throw ERROR_SESION }, etiqueta: 'b', salud, ...silencio })
    await obtenerContenidoLLM({
      ejecutar: async () => ({ choices: [{ message: { content: '' } }] }),
      etiqueta: 'c', intentos: 2, salud, ...silencio,
    })
    assert.deepEqual(
      { ...salud.resumen(), ultimoError: salud.resumen().ultimoError?.status },
      { llamadas: 3, exitos: 1, fallosProveedor: 1, fallosContenido: 1, ultimoError: 400 }
    )
  })
})

describe('MonitorSaludLLM', () => {
  test('tres rechazos seguidos del proveedor cortan la corrida', () => {
    const m = new MonitorSaludLLM()
    m.registrarFalloProveedor({ status: 400, mensaje: 'missing x-opencode-session' })
    m.registrarFalloProveedor({ status: 400, mensaje: 'missing x-opencode-session' })
    assert.equal(m.motivoParaAbortar(), null, 'dos pueden ser mala suerte con dos notas')
    m.registrarFalloProveedor({ status: 400, mensaje: 'missing x-opencode-session' })
    const motivo = m.motivoParaAbortar()
    assert.ok(motivo)
    assert.match(motivo!, /x-opencode-session/, 'el motivo tiene que traer el mensaje real del proveedor')
  })

  test('un éxito en el medio corta la racha', () => {
    const m = new MonitorSaludLLM()
    m.registrarFalloProveedor({ status: 500, mensaje: 'x' })
    m.registrarFalloProveedor({ status: 500, mensaje: 'x' })
    m.registrarExito()
    m.registrarFalloProveedor({ status: 500, mensaje: 'x' })
    assert.equal(m.motivoParaAbortar(), null)
  })

  test('muchas respuestas inservibles seguidas también cortan', () => {
    const m = new MonitorSaludLLM(3, 4)
    for (let i = 0; i < 3; i++) m.registrarFalloContenido()
    assert.equal(m.motivoParaAbortar(), null)
    m.registrarFalloContenido()
    assert.match(m.motivoParaAbortar()!, /sin una sola respuesta usable/)
  })

  test('sinNingunExito distingue "no se llamó" de "se llamó y nada anduvo"', () => {
    const m = new MonitorSaludLLM()
    assert.equal(m.sinNingunExito(), false, 'sin llamadas no hay fallo que reportar')
    m.registrarFalloProveedor({ status: 400, mensaje: 'x' })
    assert.equal(m.sinNingunExito(), true)
    m.registrarExito()
    assert.equal(m.sinNingunExito(), false)
  })
})
