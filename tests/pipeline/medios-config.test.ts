/**
 * Invariantes de la lista MEDIOS.
 *
 * Antes este test parseaba el texto de scrapear-medios.ts con regex, porque ese
 * archivo ejecuta el pipeline al importarse y no se podía leer la lista de otra
 * forma. Al extraer MEDIOS a ./medios-config —que el health-check también
 * necesita— pasó a poder importarse de verdad: con tipos, sin regex, y sin que
 * un cambio de formato del archivo rompa el test por el motivo equivocado.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MEDIOS } from '../../scripts/pipeline/medios-config'

/** La URL que el pipeline visita: urlPoliciales gana, url es el legado. */
function urlDe(m: (typeof MEDIOS)[number]): string {
  return m.urlPoliciales || m.url || ''
}

describe('la lista MEDIOS no tiene entradas rotas', () => {
  test('hay medios cargados', () => {
    assert.ok(MEDIOS.length > 50, `esperaba más de 50 medios, encontré ${MEDIOS.length}`)
  })

  test('ningún id se repite', () => {
    const vistos = new Set<string>()
    const repetidos: string[] = []
    for (const m of MEDIOS) {
      if (vistos.has(m.id)) repetidos.push(m.id)
      vistos.add(m.id)
    }
    assert.deepEqual(repetidos, [], `ids duplicados: ${repetidos.join(', ')}`)
  })

  test('todos tienen una URL efectiva', () => {
    // Un medio sin url ni urlPoliciales se saltea en silencio en la corrida.
    const sinUrl = MEDIOS.filter(m => urlDe(m) === '')
    assert.deepEqual(sinUrl.map(m => m.id), [])
  })

  test('toda URL usa http o https', () => {
    for (const m of MEDIOS) {
      assert.match(urlDe(m), /^https?:\/\//, `${m.id}: URL sin esquema (${urlDe(m)})`)
    }
  })

  test('ningún id tiene espacios ni mayúsculas', () => {
    // Los ids se usan en --medio=<id> desde la línea de comandos.
    for (const m of MEDIOS) {
      assert.match(m.id, /^[a-z0-9]+$/, `${m.id}: el id debería ser alfanumérico minúscula`)
    }
  })

  test('todos tienen nombre legible', () => {
    for (const m of MEDIOS) {
      assert.ok(m.nombre && m.nombre.trim().length > 0, `${m.id} sin nombre`)
    }
  })
})

describe('los medios de Buenos Aires agregados en esta ronda siguen sin activar', () => {
  // No se pudo hacer fetch real a ninguno (el entorno donde se investigaron no
  // tiene salida a internet), así que quedaron en activo:false esperando el
  // health-check. Cuando corra `verificar-medios.yml` en Actions y confirme que
  // cargan y no tienen paywall, se activan y este test se actualiza a mano.
  const PENDIENTES = [
    'mdp0223', 'elmarplatense', 'lanueva', 'ecosdiarios',
    'elpopularolav', '0221laplata', 'elcomercioonline', 'vivieloeste', 'minutouno',
  ]

  test('todos existen en la lista', () => {
    const ids = new Set(MEDIOS.map(m => m.id))
    for (const id of PENDIENTES) {
      assert.ok(ids.has(id), `falta el medio "${id}"`)
    }
  })

  test('ninguno quedó activo antes de verificarlo', () => {
    for (const id of PENDIENTES) {
      const m = MEDIOS.find(x => x.id === id)
      assert.equal(m?.activo, false, `${id} se activó sin la verificación del health-check`)
    }
  })
})

describe('los medios con paywall conocido están desactivados', () => {
  test('tienePaywall implica activo:false', () => {
    // Un medio con muro de pago consume tiempo de la corrida y no deja extraer
    // el cuerpo de la nota.
    const contradictorios = MEDIOS.filter(m => m.tienePaywall === true && m.activo !== false)
    assert.deepEqual(
      contradictorios.map(m => m.id),
      [],
      'hay medios marcados con paywall pero activos'
    )
  })
})
