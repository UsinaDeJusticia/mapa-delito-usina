/**
 * El export de Parquet arma bien el SQL y no filtra la credencial.
 *
 * EL DEFECTO
 * `scripts/export/export_parquet.sql` abría con
 * `ATTACH getenv('DATABASE_URL') AS neon (...)`. Eso no funciona: el parser de
 * ATTACH en DuckDB exige un literal de string y rechaza cualquier llamada a
 * función. Verificado contra DuckDB 1.5.3, que es la versión con la que se
 * encontró el problema:
 *
 *   ATTACH getenv('DATABASE_URL') …    → Parser Error: syntax error at or near "getenv"
 *   ATTACH getvariable('neon_url') …   → Parser Error: syntax error at or near "getvariable"
 *
 * O sea que `SET VARIABLE` + `getvariable()` tampoco alcanzaba, aunque las dos
 * funciones existan y anden en un SELECT.
 *
 * Resultado: `npm run export:parquet` estaba roto para cualquiera, y el error
 * salía como seis "Catalog neon does not exist" en cascada sin apuntar a la
 * causa. Contribuyó a que el fix del hallazgo #10 tardara una semana en llegar
 * a producción.
 *
 * LO QUE FIJAN ESTOS TESTS
 * Que el preámbulo con la credencial viva en el wrapper y no en el .sql (para
 * que la URL no toque disco ni argv), que el literal se escape, y que nadie
 * vuelva a poner un `ATTACH` con función dentro del .sql.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  escaparLiteralSQL,
  componerPreambulo,
  componerSql,
  RUTA_SQL,
} from '../../scripts/export/export-parquet'

const RAIZ = process.cwd()
const SQL = readFileSync(path.join(RAIZ, RUTA_SQL), 'utf-8')
const PACKAGE = JSON.parse(readFileSync(path.join(RAIZ, 'package.json'), 'utf-8'))

/**
 * Quita los comentarios de línea, igual que tests/sql/fuente-oficial.test.ts.
 *
 * Hace falta acá porque el header del .sql documenta a propósito el `ATTACH
 * getenv(...)` que NO hay que volver a poner. Sin esto, esa advertencia hace
 * fallar el test que justamente la respalda.
 */
function sinComentarios(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n')
}

const SQL_SIN_COMENTARIOS = sinComentarios(SQL)

const URL_EJEMPLO = 'postgres://usuario:clave@ep-algo.neon.tech/neondb?sslmode=require'

describe('escaparLiteralSQL', () => {
  test('deja intacta una URL normal', () => {
    assert.equal(escaparLiteralSQL(URL_EJEMPLO), URL_EJEMPLO)
  })

  test('duplica las comillas simples', () => {
    // Una contraseña de Neon puede tener una comilla simple. Sin escapar, el
    // ATTACH queda sintácticamente roto.
    assert.equal(escaparLiteralSQL("clave'con'comillas"), "clave''con''comillas")
  })

  test('escapa una URL completa con comilla en la contraseña', () => {
    const conComilla = "postgres://u:cla've@host/db"
    assert.equal(escaparLiteralSQL(conComilla), "postgres://u:cla''ve@host/db")
  })

  test('no toca las comillas dobles ni las barras', () => {
    assert.equal(escaparLiteralSQL('a"b\\c'), 'a"b\\c')
  })
})

describe('componerPreambulo', () => {
  const preambulo = componerPreambulo(URL_EJEMPLO)

  test('carga la extensión postgres antes del ATTACH', () => {
    // El orden importa: ATTACH … (TYPE postgres) falla si la extensión no se
    // cargó todavía.
    const iLoad = preambulo.indexOf('LOAD postgres')
    const iAttach = preambulo.indexOf('ATTACH')
    assert.ok(iLoad !== -1 && iAttach !== -1)
    assert.ok(iLoad < iAttach, 'LOAD postgres tiene que ir antes del ATTACH')
  })

  test('el ATTACH usa un literal, no una llamada a función', () => {
    assert.match(preambulo, /ATTACH '[^']*' AS neon/)
    assert.ok(
      !/ATTACH\s+get(env|variable)\s*\(/.test(preambulo),
      'el parser de ATTACH rechaza las llamadas a función — ver el comentario de arriba'
    )
  })

  test('abre la conexión en READ_ONLY', () => {
    // El export no debe poder escribir en producción por accidente.
    assert.match(preambulo, /READ_ONLY/)
  })
})

describe('componerSql', () => {
  test('mete el preámbulo antes de las consultas del archivo', () => {
    const completo = componerSql(URL_EJEMPLO, SQL)
    assert.ok(completo.indexOf('ATTACH') < completo.indexOf('COPY'))
  })

  test('conserva el contenido del .sql sin modificarlo', () => {
    assert.ok(componerSql(URL_EJEMPLO, SQL).includes(SQL))
  })
})

describe('el .sql no lleva la credencial ni un ATTACH roto', () => {
  test('no contiene ningún ATTACH', () => {
    // El ATTACH vive en el wrapper porque lleva la credencial. Si vuelve acá,
    // o se rompe (con getenv) o se filtra la URL (con un literal).
    assert.ok(
      !/^\s*ATTACH\b/m.test(SQL_SIN_COMENTARIOS),
      'volvió un ATTACH al .sql: lo aporta export-parquet.ts por stdin'
    )
  })

  test('no quedó ningún getenv()', () => {
    assert.ok(
      !/getenv\s*\(/.test(SQL_SIN_COMENTARIOS),
      'getenv() no funciona dentro de ATTACH'
    )
  })

  test('no hay una URL de conexión hardcodeada', () => {
    assert.ok(
      !/postgres(ql)?:\/\/[^\s']*:[^\s']*@/.test(SQL_SIN_COMENTARIOS),
      'hay algo que parece una credencial embebida en el .sql'
    )
  })

  test('sigue generando los 5 Parquet', () => {
    for (const archivo of [
      'snic_provincia.parquet',
      'snic_provincia_delito.parquet',
      'sat_provincia.parquet',
      'anios_disponibles.parquet',
      'hechos_sat.parquet',
    ]) {
      assert.ok(SQL.includes(`public/data/${archivo}`), `falta ${archivo}`)
    }
  })
})

describe('el script de npm apunta al wrapper', () => {
  test('export:parquet corre export-parquet.ts, no duckdb directo', () => {
    const script = PACKAGE.scripts['export:parquet']
    assert.match(script, /export-parquet\.ts/)
    assert.ok(
      !/duckdb\s*</.test(script),
      'volvió el `duckdb < …` directo, que falla porque el .sql ya no trae el ATTACH'
    )
  })
})

describe('el .gitignore cubre las copias temporales del export', () => {
  test('export_temp.sql está ignorado', () => {
    // Al aplicar el hallazgo #10 hubo que improvisar un export_temp.sql con la
    // URL de producción inline. No estaba ignorado: lo único que evitó
    // commitear la credencial fue no haber hecho `git add .`.
    const gitignore = readFileSync(path.join(RAIZ, '.gitignore'), 'utf-8')
    assert.match(gitignore, /^export_temp\.sql$/m)
  })
})
