/**
 * "Sin dato" no es "cero".
 *
 * EL DEFECTO
 * `estadisticas_agregadas.cantidad_victimas` es nullable y buena parte de las
 * filas del SNIC no lo traen. Cuando `SUM(cantidad_victimas)` no encuentra
 * ningún valor devuelve NULL, y el código hacía `Number(null)` → `0`. El mapa
 * terminaba afirmando "0 víctimas" en provincias donde no se sabe cuántas hubo.
 *
 * Para una organización de derechos de víctimas de homicidio eso no es un
 * detalle de formato: es publicar que no hubo víctimas donde sí las hubo.
 *
 * Estos tests fijan la regla: null se propaga y se muestra como tal, 0 solo
 * aparece cuando alguien midió cero, y un total al que le faltan sumandos se
 * declara parcial en lugar de pasar por definitivo.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SIN_DATO,
  PARCIAL,
  numeroONull,
  sumarConDato,
  agregarMetrica,
  esParcial,
  formatearMetrica,
  formatearAgregado,
  detalleParcial,
  promedio,
  formatearPromedio,
} from '../../src/lib/mapa/metricas'

describe('numeroONull', () => {
  test('null y undefined no se convierten en cero', () => {
    // Este es exactamente el bug: Number(null) === 0.
    assert.equal(Number(null), 0, 'premisa: así se comportaba antes')
    assert.equal(numeroONull(null), null)
    assert.equal(numeroONull(undefined), null)
  })

  test('el cero real se preserva', () => {
    // Un cero medido es un dato y tiene que sobrevivir intacto.
    assert.equal(numeroONull(0), 0)
    assert.equal(numeroONull('0'), 0)
  })

  test('convierte números, strings numéricos y BigInt', () => {
    assert.equal(numeroONull(42), 42)
    assert.equal(numeroONull('42'), 42)
    // Postgres devuelve los conteos grandes como BigInt.
    assert.equal(numeroONull(BigInt(1234)), 1234)
  })

  test('lo que no es un número es ausencia de dato, no cero', () => {
    for (const v of ['', 'hola', {}, [], NaN, Infinity, -Infinity]) {
      assert.equal(numeroONull(v), null, `${JSON.stringify(v)} debería ser null`)
    }
  })
})

describe('sumarConDato', () => {
  test('null + null es null: nadie aportó dato', () => {
    assert.equal(sumarConDato(null, null), null)
  })

  test('null + n es n, no NaN', () => {
    assert.equal(sumarConDato(null, 5), 5)
    assert.equal(sumarConDato(5, null), 5)
  })

  test('cero + null es cero, no null', () => {
    // El cero es un dato: aportó, y el resultado sigue siendo un dato.
    assert.equal(sumarConDato(0, null), 0)
  })

  test('suma normal', () => {
    assert.equal(sumarConDato(3, 4), 7)
  })
})

describe('agregarMetrica', () => {
  test('sin ningún dato el total es null, no 0', () => {
    const a = agregarMetrica([null, null, null])
    assert.equal(a.valor, null)
    assert.equal(a.conDato, 0)
    assert.equal(a.sinDato, 3)
    assert.equal(esParcial(a), false, 'no es parcial: no hay nada sumado a medias')
  })

  test('una lista vacía también es sin dato', () => {
    assert.equal(agregarMetrica([]).valor, null)
  })

  test('con todos los datos el total es completo', () => {
    const a = agregarMetrica([1, 2, 3])
    assert.equal(a.valor, 6)
    assert.equal(a.sinDato, 0)
    assert.equal(esParcial(a), false)
  })

  test('con datos faltantes el total es parcial y se sabe cuántos faltan', () => {
    const a = agregarMetrica([10, null, 5, null, undefined])
    assert.equal(a.valor, 15, 'suma solo lo que existe')
    assert.equal(a.conDato, 2)
    assert.equal(a.sinDato, 3)
    assert.equal(esParcial(a), true)
  })

  test('los ceros cuentan como dato, no como faltante', () => {
    const a = agregarMetrica([0, 0])
    assert.equal(a.valor, 0)
    assert.equal(a.conDato, 2)
    assert.equal(esParcial(a), false, 'medir cero dos veces da un cero definitivo')
  })
})

describe('formatearMetrica', () => {
  test('la ausencia se dice, no se muestra como 0', () => {
    assert.equal(formatearMetrica(null), SIN_DATO)
    assert.equal(formatearMetrica(undefined), SIN_DATO)
    assert.notEqual(formatearMetrica(null), '0')
  })

  test('el cero medido se muestra como 0', () => {
    assert.equal(formatearMetrica(0), '0')
  })

  test('usa separador de miles argentino', () => {
    assert.equal(formatearMetrica(1234567), (1234567).toLocaleString('es-AR'))
  })

  test('NaN e Infinity no se muestran como números', () => {
    assert.equal(formatearMetrica(NaN), SIN_DATO)
    assert.equal(formatearMetrica(Infinity), SIN_DATO)
  })
})

describe('formatearAgregado', () => {
  test('un total incompleto se declara parcial', () => {
    const texto = formatearAgregado(agregarMetrica([100, null]))
    assert.ok(texto.includes('100'), 'muestra lo que sí sabe')
    assert.ok(texto.includes(PARCIAL), 'y avisa que está incompleto')
  })

  test('un total completo se muestra limpio', () => {
    assert.equal(formatearAgregado(agregarMetrica([100, 50])), (150).toLocaleString('es-AR'))
  })

  test('sin ningún dato dice sin dato', () => {
    assert.equal(formatearAgregado(agregarMetrica([null, null])), SIN_DATO)
  })
})

describe('detalleParcial', () => {
  test('explica cuántas jurisdicciones faltan y que el total real es mayor', () => {
    const texto = detalleParcial(agregarMetrica([1, null, null]), 'provincias')
    assert.ok(texto, 'debería haber explicación')
    assert.match(texto!, /1 de 3 provincias/)
    assert.match(texto!, /mayor/, 'tiene que decir que el total real es más alto')
  })

  test('con el total completo no hay nada que aclarar', () => {
    assert.equal(detalleParcial(agregarMetrica([1, 2])), null)
  })

  test('sin ningún dato explica que la fuente no lo informa', () => {
    const texto = detalleParcial(agregarMetrica([null]), 'provincias')
    assert.match(texto!, /no informa/)
  })
})

describe('promedio', () => {
  test('sin numerador no hay promedio', () => {
    assert.equal(promedio(null, 10), null)
    assert.equal(formatearPromedio(null, 10), '—')
  })

  test('no divide por cero: nada de ∞ víctimas por hecho', () => {
    assert.equal(promedio(10, 0), null)
    assert.equal(formatearPromedio(10, 0), '—')
  })

  test('calcula con dos decimales', () => {
    assert.equal(formatearPromedio(3, 2), '1.50')
  })

  test('un numerador cero da un promedio cero, no un guión', () => {
    // Cero víctimas medidas sobre 5 hechos es información: el promedio es 0.
    assert.equal(formatearPromedio(0, 5), '0.00')
  })
})

describe('la regresión concreta que motivó el módulo', () => {
  test('una provincia sin conteo de víctimas no reporta cero víctimas', () => {
    // Lo que devuelve mv_snic_provincia cuando ninguna fila trae víctimas.
    const filaDeLaVista = { total_hechos: 312, total_victimas: null }

    const victimas = numeroONull(filaDeLaVista.total_victimas)
    assert.equal(victimas, null)
    assert.equal(formatearMetrica(victimas), SIN_DATO)

    // El comportamiento anterior, para dejar constancia de qué se arregló.
    assert.equal(Number(filaDeLaVista.total_victimas), 0)
  })

  test('el total nacional no se calcula sumando los faltantes como cero', () => {
    // 3 provincias con dato, 21 sin dato.
    const provincias = [
      { totalVictimas: 100 },
      { totalVictimas: 50 },
      { totalVictimas: 25 },
      ...Array.from({ length: 21 }, () => ({ totalVictimas: null as number | null })),
    ]

    const agregado = agregarMetrica(provincias.map(p => p.totalVictimas))
    assert.equal(agregado.valor, 175)
    assert.equal(
      esParcial(agregado),
      true,
      'presentar 175 como el total nacional sería subestimar la cifra real'
    )
    assert.ok(formatearAgregado(agregado).includes(PARCIAL))
  })
})
