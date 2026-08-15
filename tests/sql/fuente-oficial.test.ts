/**
 * El modo SAT del mapa solo cuenta fuentes oficiales (hallazgo #10).
 *
 * EL DEFECTO
 * `mv_sat_provincia` y compañía filtraban únicamente por `es_agregado = false`.
 * Ese filtro separa el dato anual agregado del SNIC de los microdatos
 * individuales, pero NO distingue de dónde vienen esos microdatos: caían en la
 * misma bolsa los del SAT (oficiales) y los del pipeline de medios
 * (PRELIMINARES, sin confirmar). El panel rotula ese total como
 * "OFICIAL — SAT", así que estaba presentando cifras periodísticas sin
 * verificar como estadística oficial.
 *
 * LA CORRECCIÓN
 * `fuentes.tipo` ya era un enum estable (OFICIAL / PERIODISTICA / CIUDADANA /
 * USINA / ACADEMICA): las dos ingestas oficiales crean su fuente con
 * tipo='OFICIAL' y el pipeline con tipo='PERIODISTICA'. Alcanza con filtrar
 * por ahí. (El comentario que estaba en el SQL afirmaba que hacía falta agregar
 * una columna `codigo` porque "Fuente solo tiene nombre"; era un error de
 * lectura del esquema.)
 *
 * QUÉ FIJAN ESTOS TESTS
 * Que los CUATRO lugares que consultan microdatos para el modo SAT lleven el
 * filtro. Son cuatro caminos distintos hacia el mismo número, y arreglar solo
 * algunos deja el defecto vivo:
 *   1. mv_sat_provincia          — el agregado por provincia
 *   2. mv_anios_disponibles      — qué años ofrece el selector en modo SAT
 *   3. getEstadisticasSATFiltrado — la consulta con filtros (sexo, arma…)
 *   4. hechos_sat.parquet        — el camino POR DEFECTO del mapa (DuckDB en
 *                                  el browser); la API es solo el respaldo
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()

const VISTAS = readFileSync(
  path.join(RAIZ, 'scripts/sql/create-materialized-views.sql'),
  'utf-8'
)
const EXPORT_PARQUET = readFileSync(
  path.join(RAIZ, 'scripts/export/export_parquet.sql'),
  'utf-8'
)
const QUERIES = readFileSync(path.join(RAIZ, 'src/lib/mapa/queries.ts'), 'utf-8')
const SCHEMA = readFileSync(path.join(RAIZ, 'prisma/schema.prisma'), 'utf-8')

/** Quita comentarios de línea SQL para no dar por buena una regla comentada. */
function sinComentarios(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n')
}

/** El cuerpo de un CREATE MATERIALIZED VIEW, sin comentarios. */
function cuerpoVista(nombre: string): string {
  const limpio = sinComentarios(VISTAS)
  const inicio = limpio.indexOf(`CREATE MATERIALIZED VIEW ${nombre} AS`)
  assert.notEqual(inicio, -1, `no se encontró la definición de ${nombre}`)
  const fin = limpio.indexOf(';', inicio)
  return limpio.slice(inicio, fin)
}

describe('el enum de tipo de fuente sigue existiendo en el esquema', () => {
  test('TipoFuente tiene OFICIAL y PERIODISTICA', () => {
    // Toda la corrección se apoya en este enum. Si alguien lo renombra o le
    // saca un valor, los filtros de abajo quedan apuntando a la nada.
    assert.match(SCHEMA, /enum TipoFuente/)
    assert.match(SCHEMA, /^\s*OFICIAL\b/m)
    assert.match(SCHEMA, /^\s*PERIODISTICA\b/m)
  })

  test('Fuente.tipo existe y es del enum', () => {
    assert.match(SCHEMA, /tipo\s+TipoFuente/)
  })

  test('fuente_id es NOT NULL, así que el JOIN puede ser INNER', () => {
    // Si fuenteId pasara a opcional, un INNER JOIN empezaría a descartar filas
    // en silencio y los totales bajarían sin que nadie lo note.
    assert.match(
      SCHEMA,
      /fuenteId\s+String\s+@map\("fuente_id"\)/,
      'fuenteId dejó de ser obligatorio: revisar los JOIN de las vistas SAT'
    )
  })
})

describe('mv_sat_provincia solo cuenta fuentes oficiales', () => {
  const cuerpo = cuerpoVista('mv_sat_provincia')

  test('hace JOIN contra fuentes', () => {
    assert.match(cuerpo, /JOIN\s+fuentes\s+f\s+ON\s+hd\.fuente_id\s*=\s*f\.id/)
  })

  test("filtra por f.tipo = 'OFICIAL'", () => {
    assert.match(
      cuerpo,
      /f\.tipo\s*=\s*'OFICIAL'/,
      'sin este filtro el total rotulado "OFICIAL — SAT" incluye casos del pipeline'
    )
  })

  test('conserva el filtro es_agregado = false', () => {
    // Los dos filtros son necesarios y distintos: es_agregado separa el dato
    // anual del SNIC de los microdatos; tipo separa oficial de periodístico.
    assert.match(cuerpo, /es_agregado\s*=\s*false/)
  })
})

describe('mv_anios_disponibles no ofrece años que solo tiene el pipeline', () => {
  const cuerpo = cuerpoVista('mv_anios_disponibles')

  test('la rama sat filtra por tipo de fuente', () => {
    const sat = cuerpo.slice(cuerpo.indexOf("'sat' AS fuente"))
    assert.match(sat, /JOIN\s+fuentes\s+f\s+ON\s+hd\.fuente_id\s*=\s*f\.id/)
    assert.match(sat, /f\.tipo\s*=\s*'OFICIAL'/)
  })

  test('la rama snic sigue leyendo estadisticas_agregadas', () => {
    // El SNIC no pasa por hechos_delictivos, así que este filtro no le aplica.
    const snic = cuerpo.slice(
      cuerpo.indexOf("'snic' AS fuente"),
      cuerpo.indexOf("'sat' AS fuente")
    )
    assert.match(snic, /estadisticas_agregadas/)
  })
})

describe('getEstadisticasSATFiltrado lleva el mismo filtro', () => {
  test("incluye f.tipo = 'OFICIAL' en las condiciones", () => {
    assert.match(
      QUERIES,
      /f\.tipo\s*=\s*'OFICIAL'/,
      'la consulta con filtros SAT alimenta el mismo panel y necesita el mismo filtro'
    )
  })

  test('hace el JOIN que ese filtro necesita', () => {
    assert.match(QUERIES, /JOIN\s+fuentes\s+f\s+ON\s+hd\.fuente_id\s*=\s*f\.id/)
  })
})

describe('el Parquet de hechos SAT lleva el mismo filtro', () => {
  // El más importante de los cuatro: DuckDB sobre Parquet es el camino por
  // defecto del mapa. Arreglar las vistas y no esto no se vería en producción.
  const limpio = sinComentarios(EXPORT_PARQUET)
  const fin = limpio.indexOf('hechos_sat.parquet')
  // Math.max: sin esto, un índice menor a 2000 da un inicio negativo y slice lo
  // interpreta como "desde el final", devolviendo un fragmento corto que no
  // contiene el JOIN — el test pasaría o fallaría por el motivo equivocado.
  const bloque = limpio.slice(Math.max(0, fin - 2000), fin)

  test('hace JOIN contra fuentes', () => {
    assert.match(bloque, /JOIN\s+neon\.public\.fuentes\s+f\s+ON\s+hd\.fuente_id\s*=\s*f\.id/)
  })

  test("filtra por f.tipo = 'OFICIAL'", () => {
    assert.match(
      bloque,
      /f\.tipo\s*=\s*'OFICIAL'/,
      'sin esto el mapa sigue mezclando pipeline con SAT aunque las vistas estén bien'
    )
  })
})

describe('ningún camino del modo SAT queda sin el filtro', () => {
  test('es_agregado = false nunca aparece solo en los consumidores SAT', () => {
    // Guarda genérica: en los tres archivos, cada aparición de
    // `es_agregado = false` que consulte hechos_delictivos para el modo SAT
    // tiene que estar acompañada de un filtro por tipo de fuente cerca.
    const fuentes: Array<[string, string]> = [
      ['create-materialized-views.sql', sinComentarios(VISTAS)],
      ['export_parquet.sql', sinComentarios(EXPORT_PARQUET)],
      ['queries.ts', QUERIES],
    ]

    for (const [nombre, contenido] of fuentes) {
      const apariciones = contenido.split(/es_agregado\s*=\s*false/).length - 1
      const filtros = contenido.split(/f\.tipo\s*=\s*'OFICIAL'/).length - 1
      assert.ok(
        filtros >= apariciones,
        `${nombre}: ${apariciones} usos de es_agregado = false pero solo ${filtros} ` +
        `filtros por tipo de fuente. Cada consulta de microdatos para el modo SAT ` +
        `necesita ambos.`
      )
    }
  })
})
