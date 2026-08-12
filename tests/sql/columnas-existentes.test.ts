/**
 * Verifica que los SQL de scripts/sql/ no referencien columnas inexistentes.
 *
 * Motivo concreto: create-materialized-views.sql tenía
 * `COUNT(DISTINCT hd.victima_sexo)`, y esa columna no existe — la real es
 * "victimaSexo" en camelCase, creada entrecomillada porque el modelo de Prisma
 * no le puso @map. El CREATE de esa vista fallaba siempre.
 *
 * Lo que hizo que el defecto sobreviviera meses: psql continúa después de un
 * error salvo que se le pase ON_ERROR_STOP=1. Así que el script "corría", el
 * DROP previo sí se ejecutaba, y la vista quedaba sin crear sin que nadie se
 * enterara. Aparecieron dos archivos SQL duplicados como parche.
 *
 * Alcance de la heurística: se extraen las referencias `alias.columna` y se
 * verifica que cada nombre exista como columna de alguna tabla del schema. No se
 * resuelve el alias a su tabla, porque eso exigiría un parser de SQL. Es
 * suficiente para atrapar un nombre que no existe en ninguna parte, que es el
 * caso real. La verificación fuerte es la prueba de base vacía en CI.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const DIR_SQL = path.join(RAIZ, 'scripts/sql')
const SCHEMA = path.join(RAIZ, 'prisma/schema.prisma')

/**
 * Columnas de las propias vistas materializadas y de tablas que viven fuera de
 * Prisma (revisiones_pipeline, feedback). No están en schema.prisma pero son
 * legítimas.
 */
const COLUMNAS_FUERA_DE_PRISMA = new Set([
  // Alias de salida de las vistas
  'provincia_nombre',
  'total_hechos',
  'total_victimas',
  'tipos_delito_count',
  'tipo_delito_nombre',
  'femicidios',
  'fuente',
  // revisiones_pipeline (scripts/sql/create-revisiones-pipeline.sql)
  'hecho_id',
  'url_fuente',
  'titulo_noticia',
  'texto_original',
  'clasificacion_llm',
  'confianza_llm',
  'clasificacion_humana',
  'revisado_por',
  'revisado_at',
  'notas',
  'usar_como_ejemplo',
  // feedback (scripts/sql/create-feedback.sql)
  'mensaje',
  'email',
])

/** Quita comentarios de línea y de bloque para no analizar texto explicativo. */
function sinComentarios(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

/** Nombres de columna declarados en el schema, en cualquier tabla. */
function columnasDelSchema(): Set<string> {
  const schema = readFileSync(SCHEMA, 'utf-8')
  const modelos = new Set(
    Array.from(schema.matchAll(/^model\s+(\w+)/gm), m => m[1])
  )
  const columnas = new Set<string>()

  for (const bloque of Array.from(schema.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm))) {
    for (const linea of bloque[1].split('\n')) {
      const s = linea.trim()
      if (!s || s.startsWith('//') || s.startsWith('@@')) continue
      const partes = s.split(/\s+/)
      if (partes.length < 2) continue

      const campo = partes[0]
      const tipo = partes[1].replace(/[?[\]]/g, '')
      if (modelos.has(tipo)) continue // relación, no columna

      const mapCampo = s.match(/@map\("([^"]+)"\)/)
      columnas.add((mapCampo ? mapCampo[1] : campo).toLowerCase())
    }
  }
  return columnas
}

function archivosSql(): string[] {
  return readdirSync(DIR_SQL).filter(f => f.endsWith('.sql'))
}

/** Referencias `alias.columna` de un SQL, ya sin comentarios. */
function referenciasDeColumna(sql: string): string[] {
  const limpio = sinComentarios(sql)
  return Array.from(
    new Set(
      Array.from(
        limpio.matchAll(/\b[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)\b/gi),
        m => m[1].toLowerCase()
      )
    )
  )
}

describe('sinComentarios', () => {
  test('quita comentarios de línea', () => {
    const r = sinComentarios('SELECT a.b -- hd.columna_falsa\nFROM t')
    assert.ok(!r.includes('columna_falsa'))
    assert.ok(r.includes('a.b'))
  })

  test('quita comentarios de bloque', () => {
    const r = sinComentarios('SELECT /* hd.columna_falsa */ a.b FROM t')
    assert.ok(!r.includes('columna_falsa'))
    assert.ok(r.includes('a.b'))
  })
})

describe('el schema aporta las columnas conocidas', () => {
  test('encuentra columnas de control', () => {
    const cols = columnasDelSchema()
    for (const c of ['anio', 'cantidad_hechos', 'cantidad_victimas', 'es_agregado', 'femicidio']) {
      assert.ok(cols.has(c), `${c} debería estar entre las columnas del schema`)
    }
  })

  test('victima_sexo NO existe en el schema — la real es victimaSexo', () => {
    const cols = columnasDelSchema()
    assert.ok(
      !cols.has('victima_sexo'),
      'si esta columna existiera, el bug original no habría sido un bug'
    )
    assert.ok(cols.has('victimasexo'), 'la columna real, en minúsculas para comparar')
  })
})

describe('los SQL no referencian columnas inexistentes', () => {
  const conocidas = columnasDelSchema()

  for (const archivo of archivosSql()) {
    test(`${archivo} solo usa columnas que existen`, () => {
      const sql = readFileSync(path.join(DIR_SQL, archivo), 'utf-8')
      const desconocidas = referenciasDeColumna(sql).filter(
        col => !conocidas.has(col) && !COLUMNAS_FUERA_DE_PRISMA.has(col)
      )

      assert.deepEqual(
        desconocidas,
        [],
        `${archivo} referencia columnas que no existen en schema.prisma: ` +
          `${desconocidas.join(', ')}.\n` +
          'Si son columnas legítimas de una tabla fuera de Prisma, agregalas a ' +
          'COLUMNAS_FUERA_DE_PRISMA en este test.'
      )
    })
  }

  test('regresión: sexos_distintos con victima_sexo ya no está', () => {
    const vistas = readFileSync(
      path.join(DIR_SQL, 'create-materialized-views.sql'),
      'utf-8'
    )
    const limpio = sinComentarios(vistas)
    assert.ok(
      !limpio.includes('victima_sexo'),
      'la referencia a la columna inexistente volvió al SQL'
    )
    assert.ok(
      !limpio.includes('sexos_distintos'),
      'la columna sexos_distintos volvió; ninguna consulta de la app la usaba'
    )
  })
})

describe('una sola definición por vista materializada', () => {
  test('ninguna vista se define en más de un archivo', () => {
    const definicionesPorVista = new Map<string, string[]>()

    for (const archivo of archivosSql()) {
      const sql = sinComentarios(
        readFileSync(path.join(DIR_SQL, archivo), 'utf-8')
      )
      for (const m of Array.from(
        sql.matchAll(/CREATE\s+MATERIALIZED\s+VIEW\s+(\w+)/gi)
      )) {
        const vista = m[1].toLowerCase()
        definicionesPorVista.set(vista, [
          ...(definicionesPorVista.get(vista) ?? []),
          archivo,
        ])
      }
    }

    const duplicadas = Array.from(definicionesPorVista.entries())
      .filter(([, archivos]) => archivos.length > 1)
      .map(([vista, archivos]) => `${vista} en ${archivos.join(' y ')}`)

    assert.deepEqual(
      duplicadas,
      [],
      `Hay vistas con más de una definición:\n  ${duplicadas.join('\n  ')}\n\n` +
        'Dos definiciones divergentes de la misma vista significa que nadie sabe ' +
        'cuál está desplegada. Dejá una sola.'
    )
  })

  test('las cuatro vistas que la app consulta están definidas', () => {
    const todas = archivosSql()
      .map(f => sinComentarios(readFileSync(path.join(DIR_SQL, f), 'utf-8')))
      .join('\n')

    // Estas cuatro las refresca /api/pipeline/refresh-views y las leen las
    // queries del mapa: si alguna se pierde, el mapa devuelve 500.
    for (const vista of [
      'mv_snic_provincia',
      'mv_snic_provincia_delito',
      'mv_sat_provincia',
      'mv_anios_disponibles',
    ]) {
      assert.match(
        todas,
        new RegExp(`CREATE\\s+MATERIALIZED\\s+VIEW\\s+${vista}\\b`, 'i'),
        `falta la definición de ${vista}`
      )
    }
  })
})
