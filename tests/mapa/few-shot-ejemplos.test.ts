/**
 * La query de getFewShotEjemplos() (src/lib/mapa/openrouter.ts) no resucita
 * clasificaciones superadas, no deja que un hecho ocupe varios lugares del
 * LIMIT, y ya no excluye "no es homicidio" a priori.
 *
 * Por qué esto es un test de texto y no de comportamiento: getFewShotEjemplos
 * no está exportada (necesita Prisma/Postgres reales) y este entorno de CI no
 * tiene una base disponible — mismo motivo que tests/sql/fuente-oficial.test.ts.
 * La query se verificó aparte, contra un Postgres real con datos sintéticos
 * armados a propósito para disparar cada uno de los tres defectos (ver el
 * comentario en getFewShotEjemplos con el detalle). Este test es la guarda de
 * regresión: si el texto de la query vuelve a la forma vieja, falla acá.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const OPENROUTER = readFileSync(path.join(RAIZ, 'src/lib/mapa/openrouter.ts'), 'utf-8')

/** El cuerpo de getFewShotEjemplos, para no matchear contra el resto del archivo. */
function cuerpoQuery(): string {
  const inicio = OPENROUTER.indexOf('async function getFewShotEjemplos')
  assert.notEqual(inicio, -1, 'no se encontró getFewShotEjemplos')
  const fin = OPENROUTER.indexOf('\n}', inicio)
  return OPENROUTER.slice(inicio, fin)
}

describe('getFewShotEjemplos no resucita clasificaciones superadas (staleness)', () => {
  const cuerpo = cuerpoQuery()

  test('usa DISTINCT ON (hd.id) para quedarse con un solo hecho por fila', () => {
    assert.match(
      cuerpo,
      /DISTINCT ON\s*\(\s*hd\.id\s*\)/,
      'sin esto, una corrección posterior no descarta la clasificación vieja del mismo hecho'
    )
  })

  test('ordena por revisado_at DESC antes del DISTINCT, para quedarse con la última', () => {
    assert.match(
      cuerpo,
      /ORDER BY hd\.id,\s*rp\.revisado_at DESC/,
      'DISTINCT ON sin este ORDER BY no garantiza quedarse con la fila más reciente'
    )
  })
})

describe('getFewShotEjemplos no deja que un hecho ocupe varios lugares (fanout)', () => {
  const cuerpo = cuerpoQuery()

  test('usa JOIN LATERAL contra coberturas_mediaticas, no un JOIN directo', () => {
    assert.match(
      cuerpo,
      /JOIN LATERAL\s*\(\s*SELECT resumen\s*FROM coberturas_mediaticas/,
      'un JOIN directo contra coberturas multiplica filas por cada nota del mismo hecho'
    )
  })

  test('el LATERAL trae como mucho una cobertura por hecho (LIMIT 1)', () => {
    const lateral = cuerpo.slice(cuerpo.indexOf('JOIN LATERAL'), cuerpo.indexOf('ORDER BY hd.id'))
    assert.match(lateral, /LIMIT 1/)
  })
})

describe('getFewShotEjemplos ya no excluye "no es homicidio" a priori', () => {
  const cuerpo = cuerpoQuery()

  test('no queda ningún filtro que descarte no_es_homicidio', () => {
    assert.ok(
      !/!=\s*'no_es_homicidio'/.test(cuerpo),
      'volvió el filtro que excluía los ejemplos negativos de la query'
    )
  })
})

describe('getFewShotEjemplos prioriza usar_como_ejemplo', () => {
  const cuerpo = cuerpoQuery()

  test('selecciona la columna usar_como_ejemplo', () => {
    assert.match(cuerpo, /rp\.usar_como_ejemplo/)
  })

  test('ordena por usar_como_ejemplo DESC antes que por fecha', () => {
    assert.match(cuerpo, /ORDER BY usar_como_ejemplo DESC,\s*revisado_at DESC/)
  })
})

describe('el ejemplo few-shot ya no es un JSON fijo', () => {
  test('extraerDatosNoticia usa construirEjemplosFewShot, no un objeto literal', () => {
    assert.match(OPENROUTER, /construirEjemplosFewShot\(ejemplos\)/)
    // Guarda directa contra el bug original: ese literal ya no debe existir.
    assert.ok(
      !/esHechoDelictivo:\s*true,\s*confianzaExtraccion:\s*90\s*\}\)\s*,?\s*\}\)/.test(OPENROUTER),
      'volvió el JSON de ejemplo fijo, igual para toda clasificación'
    )
  })

  test('construirEjemplosFewShot está exportada (hace falta para poder testearla sin DB ni LLM)', () => {
    assert.match(OPENROUTER, /export function construirEjemplosFewShot/)
  })
})
