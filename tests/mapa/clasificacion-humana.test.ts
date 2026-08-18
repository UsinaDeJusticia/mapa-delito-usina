/**
 * efectoDeClasificacion() y construirEjemplosFewShot().
 *
 * Dos defectos reales, encontrados juntos porque comparten la misma causa: el
 * mapeo de "clasificación humana → efecto sobre el hecho" vivía SOLO adentro
 * de route.ts, y openrouter.ts no tenía ninguna forma de traducir
 * clasificacion_humana a algo que el modelo pudiera aprender.
 *
 * 1. RECLASIFICAR A no_es_homicidio NO LIMPIABA femicidio. Un caso que una
 *    persona marcó "femicidio" y luego, leyendo más, corrigió a "no es
 *    homicidio" seguía guardado con femicidio='Si' — la corrección quedaba a
 *    medias. femicidio es un subtipo de homicidio: si no es homicidio, no
 *    puede ser femicidio. Sin ambigüedad, así que se limpia siempre.
 *
 * 2. EL EJEMPLO FEW-SHOT ERA UN JSON FIJO. openrouter.ts pedía
 *    clasificacion_humana en su query pero el mensaje 'assistant' que le
 *    mandaba al modelo era siempre el mismo — {esHechoDelictivo: true,
 *    confianzaExtraccion: 90} — sin importar si el humano había marcado
 *    femicidio, narcotráfico o "no es homicidio". El "aprendizaje" de
 *    ejemplos humanos no enseñaba ninguna diferencia entre clasificaciones.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  efectoDeClasificacion,
  esHomicidioSegunClasificacion,
} from '../../src/lib/mapa/clasificacion-humana'
import { construirEjemplosFewShot } from '../../src/lib/mapa/openrouter'

describe('efectoDeClasificacion', () => {
  test('femicidio → código 1, marcado como femicidio', () => {
    assert.deepEqual(efectoDeClasificacion('femicidio'), { snicCodigo: 1, esFemicidio: true })
  })

  test('homicidio_doloso → código 1, no femicidio', () => {
    assert.deepEqual(efectoDeClasificacion('homicidio_doloso'), { snicCodigo: 1, esFemicidio: false })
  })

  test('homicidio_en_ocasion_de_robo → código 1, no femicidio', () => {
    assert.deepEqual(
      efectoDeClasificacion('homicidio_en_ocasion_de_robo'),
      { snicCodigo: 1, esFemicidio: false }
    )
  })

  test('homicidio_vinculado_al_narcotrafico → código 1, no femicidio', () => {
    assert.deepEqual(
      efectoDeClasificacion('homicidio_vinculado_al_narcotrafico'),
      { snicCodigo: 1, esFemicidio: false }
    )
  })

  test('no_es_homicidio → sin código, no femicidio', () => {
    assert.deepEqual(efectoDeClasificacion('no_es_homicidio'), { snicCodigo: null, esFemicidio: false })
  })

  test('un valor desconocido cae al mismo fallback que "no es homicidio"', () => {
    // Cubre 'violencia_policial' (válido en el CHECK de revisiones_pipeline
    // pero sin botón ni entrada todavía — gap real y separado, documentado en
    // el módulo) y cualquier valor futuro no contemplado. Falla cerrado: un
    // valor que no se reconoce nunca marca femicidio ni asigna un código.
    assert.deepEqual(efectoDeClasificacion('violencia_policial'), { snicCodigo: null, esFemicidio: false })
    assert.deepEqual(efectoDeClasificacion(''), { snicCodigo: null, esFemicidio: false })
  })

  test('nunca devuelve esFemicidio=true sin snicCodigo (femicidio implica homicidio)', () => {
    const clasificaciones = [
      'homicidio_doloso', 'homicidio_en_ocasion_de_robo', 'femicidio',
      'homicidio_vinculado_al_narcotrafico', 'no_es_homicidio', 'violencia_policial', 'algo_inventado',
    ]
    for (const c of clasificaciones) {
      const efecto = efectoDeClasificacion(c)
      if (efecto.esFemicidio) assert.notEqual(efecto.snicCodigo, null, `${c}: femicidio sin código SNIC`)
    }
  })
})

describe('esHomicidioSegunClasificacion', () => {
  test('true para las cuatro clasificaciones de homicidio', () => {
    for (const c of [
      'homicidio_doloso', 'homicidio_en_ocasion_de_robo', 'femicidio', 'homicidio_vinculado_al_narcotrafico',
    ]) {
      assert.equal(esHomicidioSegunClasificacion(c), true, c)
    }
  })

  test('false para no_es_homicidio y para valores desconocidos', () => {
    assert.equal(esHomicidioSegunClasificacion('no_es_homicidio'), false)
    assert.equal(esHomicidioSegunClasificacion('violencia_policial'), false)
  })
})

describe('construirEjemplosFewShot', () => {
  test('sin ejemplos, no manda ningún mensaje', () => {
    assert.deepEqual(construirEjemplosFewShot([]), [])
  })

  test('un ejemplo produce exactamente un par user/assistant', () => {
    const mensajes = construirEjemplosFewShot([{ resumen: 'Texto de prueba', clasificacion: 'homicidio_doloso' }])
    assert.equal(mensajes.length, 2)
    assert.equal(mensajes[0].role, 'user')
    assert.equal(mensajes[1].role, 'assistant')
  })

  test('el mensaje user incluye el resumen tal cual', () => {
    const mensajes = construirEjemplosFewShot([{ resumen: 'ABC-123', clasificacion: 'homicidio_doloso' }])
    assert.ok(mensajes[0].content.includes('ABC-123'))
  })

  test('femicidio produce un assistant con snic_codigo=1 y es_femicidio=true', () => {
    const mensajes = construirEjemplosFewShot([{ resumen: 'r', clasificacion: 'femicidio' }])
    const asistente = JSON.parse(mensajes[1].content)
    assert.equal(asistente.esHechoDelictivo, true)
    assert.equal(asistente.snic_codigo, 1)
    assert.equal(asistente.es_femicidio, true)
  })

  test('no_es_homicidio produce un assistant con esHechoDelictivo=false — el ejemplo negativo', () => {
    // Antes esta clasificación se excluía de la query, y aunque hubiera
    // llegado, el mensaje fijo decía esHechoDelictivo:true igual. Este es el
    // caso que prueba que ahora sí se aprende de un falso positivo real.
    const mensajes = construirEjemplosFewShot([{ resumen: 'r', clasificacion: 'no_es_homicidio' }])
    const asistente = JSON.parse(mensajes[1].content)
    assert.equal(asistente.esHechoDelictivo, false)
    assert.equal(asistente.snic_codigo, null)
    assert.equal(asistente.es_femicidio, false)
  })

  test('homicidio_vinculado_al_narcotrafico NO se confunde con femicidio', () => {
    // El bug original: el assistant era el mismo JSON fijo para las tres
    // clasificaciones. Este test falla si alguna vez vuelve a colapsar todo a
    // un solo ejemplo genérico.
    const mensajes = construirEjemplosFewShot([{ resumen: 'r', clasificacion: 'homicidio_vinculado_al_narcotrafico' }])
    const asistente = JSON.parse(mensajes[1].content)
    assert.equal(asistente.es_femicidio, false)
    assert.equal(asistente.snic_codigo, 1)
  })

  test('varios ejemplos con distinta clasificación producen distinto assistant cada uno', () => {
    const mensajes = construirEjemplosFewShot([
      { resumen: 'r1', clasificacion: 'femicidio' },
      { resumen: 'r2', clasificacion: 'no_es_homicidio' },
      { resumen: 'r3', clasificacion: 'homicidio_doloso' },
    ])
    assert.equal(mensajes.length, 6)
    const asistentes = [mensajes[1], mensajes[3], mensajes[5]].map(m => m.content)
    // Antes del fix las tres eran literalmente el mismo string.
    assert.equal(new Set(asistentes).size, 3, 'los tres ejemplos deberían producir respuestas distintas')
  })

  test('preserva el orden de entrada', () => {
    const mensajes = construirEjemplosFewShot([
      { resumen: 'primero', clasificacion: 'homicidio_doloso' },
      { resumen: 'segundo', clasificacion: 'no_es_homicidio' },
    ])
    assert.ok(mensajes[0].content.includes('primero'))
    assert.ok(mensajes[2].content.includes('segundo'))
  })
})
