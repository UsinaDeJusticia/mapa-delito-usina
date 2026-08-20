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

describe('los medios de Buenos Aires quedaron según lo que dijo el health-check', () => {
  // La corrida de verificar-medios.yml (run 32397123698) resolvió los 9
  // candidatos que estaban esperando. Este test fija ese resultado: no es una
  // decisión de diseño, es lo que devolvió la verificación real.
  const ACTIVADOS = [
    'mdp0223', 'elmarplatense', 'lanueva', '0221laplata',
    'elcomercioonline', 'vivieloeste', 'minutouno',
  ]
  const RECHAZADOS = {
    // Dominio que no resuelve — el health-check evitó activar un medio muerto.
    elpopularolav: 'DNS muerto',
    // 403 más el indicio de paywall que ya venía marcado.
    ecosdiarios: '403 + paywall',
  }

  test('todos existen en la lista', () => {
    const ids = new Set(MEDIOS.map(m => m.id))
    for (const id of [...ACTIVADOS, ...Object.keys(RECHAZADOS)]) {
      assert.ok(ids.has(id), `falta el medio "${id}"`)
    }
  })

  test('los 7 que respondieron OK quedaron activos', () => {
    for (const id of ACTIVADOS) {
      assert.notEqual(
        MEDIOS.find(m => m.id === id)?.activo, false,
        `${id} pasó el health-check pero sigue desactivado`
      )
    }
  })

  test('los 2 que fallaron siguen desactivados', () => {
    for (const [id, motivo] of Object.entries(RECHAZADOS)) {
      assert.equal(
        MEDIOS.find(m => m.id === id)?.activo, false,
        `${id} se activó pese a fallar el health-check (${motivo})`
      )
    }
  })
})

describe('los medios con fallo inequívoco están desactivados', () => {
  // DNS que no resuelve y TLS inválido: no hay WAF de por medio, así que el
  // veredicto es concluyente. Cada uno gastaba tiempo de la corrida diaria.
  const MUERTOS = {
    jornada: 'dominio no resuelve',
    lamanana: 'dominio no resuelve',
    cadenaargentina: 'certificado TLS inválido',
  }

  for (const [id, motivo] of Object.entries(MUERTOS)) {
    test(`${id} está desactivado (${motivo})`, () => {
      assert.equal(MEDIOS.find(m => m.id === id)?.activo, false)
    })
  }
})

describe('cobertura por provincia', () => {
  test('Formosa quedó sin medios: hay que reemplazar lamanana', () => {
    // Se documenta el hueco en vez de dejarlo pasar en silencio. Cuando se
    // agregue un medio de Formosa, este test se invierte.
    const formosa = MEDIOS.filter(m => m.provincia === 'Formosa' && m.activo !== false)
    assert.equal(
      formosa.length, 0,
      'ya hay un medio de Formosa activo: actualizar este test y cerrar el hueco'
    )
  })

  test('Buenos Aires tiene al menos 12 medios activos', () => {
    // Es la provincia con más homicidios y la audiencia principal del mapa.
    const ba = MEDIOS.filter(m => m.provincia === 'Buenos Aires' && m.activo !== false)
    assert.ok(ba.length >= 12, `solo ${ba.length} medios activos en Buenos Aires`)
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
