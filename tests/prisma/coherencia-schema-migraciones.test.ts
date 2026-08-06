/**
 * Coherencia entre prisma/schema.prisma y prisma/migrations/.
 *
 * Este repo acumuló dos veces la misma clase de defecto: una columna declarada
 * en el schema, aplicada a mano contra Neon, y sin migración que la respalde.
 * En producción funciona y por eso pasa inadvertido; sobre una base nueva el
 * pipeline revienta con P2022 en la primera consulta.
 *
 * El test parsea el schema, se queda con los campos escalares (las relaciones no
 * generan columna) y verifica que cada columna aparezca en algún .sql de
 * migración. Corre offline, sin base de datos.
 *
 * Nota sobre el alcance: comprueba que la columna esté *mencionada*, no que el
 * tipo coincida. Un test de tipos exactos exigiría un parser de SQL; la
 * verificación fuerte de que el esquema completo se puede reconstruir es la
 * prueba de base vacía en CI, que va por separado.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// process.cwd() en vez de import.meta.dirname: tsx transpila a CJS y ahí
// import.meta no existe. Los scripts de npm corren siempre desde la raíz.
const RAIZ = process.cwd()
const SCHEMA = path.join(RAIZ, 'prisma/schema.prisma')
const DIR_MIGRACIONES = path.join(RAIZ, 'prisma/migrations')

interface CampoEscalar {
  modelo: string
  tabla: string
  campo: string
  columna: string
}

function leerSchema(): string {
  return readFileSync(SCHEMA, 'utf-8')
}

/** Junta el SQL de todas las migraciones en un solo string. */
function sqlDeMigraciones(): string {
  const partes: string[] = []
  for (const entrada of readdirSync(DIR_MIGRACIONES)) {
    const ruta = path.join(DIR_MIGRACIONES, entrada)
    if (!statSync(ruta).isDirectory()) continue
    for (const archivo of readdirSync(ruta)) {
      if (archivo.endsWith('.sql')) {
        partes.push(readFileSync(path.join(ruta, archivo), 'utf-8'))
      }
    }
  }
  return partes.join('\n')
}

/**
 * Extrae los campos escalares de cada modelo con su nombre de columna real.
 *
 * Un campo cuyo tipo es otro modelo es una relación y no genera columna, así que
 * se descarta. Los enums sí generan columna.
 */
function camposEscalares(schema: string): CampoEscalar[] {
  const modelos = new Set(
    Array.from(schema.matchAll(/^model\s+(\w+)/gm), m => m[1])
  )

  const resultado: CampoEscalar[] = []

  for (const bloque of Array.from(schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm))) {
    const modelo = bloque[1]
    const cuerpo = bloque[2]

    const mapTabla = cuerpo.match(/@@map\("([^"]+)"\)/)
    const tabla = mapTabla ? mapTabla[1] : modelo

    for (const linea of cuerpo.split('\n')) {
      const s = linea.trim()
      if (!s || s.startsWith('//') || s.startsWith('@@')) continue

      const partes = s.split(/\s+/)
      if (partes.length < 2) continue

      const campo = partes[0]
      const tipo = partes[1].replace(/[?[\]]/g, '')

      // Relación: el tipo es otro modelo. No hay columna.
      if (modelos.has(tipo)) continue

      const mapCampo = s.match(/@map\("([^"]+)"\)/)
      const columna = mapCampo ? mapCampo[1] : campo

      resultado.push({ modelo, tabla, campo, columna })
    }
  }

  return resultado
}

describe('el parser del schema funciona', () => {
  test('encuentra los modelos y campos esperados', () => {
    const campos = camposEscalares(leerSchema())
    assert.ok(campos.length > 20, `esperaba muchos campos, encontré ${campos.length}`)

    const nombres = campos.map(c => `${c.tabla}.${c.columna}`)
    // Muestras de control: si el parser se rompe, estas desaparecen.
    assert.ok(nombres.includes('hechos_delictivos.id'))
    assert.ok(nombres.includes('hechos_delictivos.fecha_hecho'))
    assert.ok(nombres.includes('hechos_delictivos.requiere_revision'))
    assert.ok(nombres.includes('coberturas_mediaticas.url'))
  })

  test('descarta las relaciones, que no son columnas', () => {
    const campos = camposEscalares(leerSchema())
    const columnas = campos
      .filter(c => c.tabla === 'hechos_delictivos')
      .map(c => c.columna)

    // Estos son campos de relación de HechoDelictivo: no generan columna.
    // La FK real sí existe y se llama distinto (tipo_delito_id, ubicacion_id...).
    for (const relacion of ['tipoDelito', 'ubicacion', 'fuente', 'casoUsina', 'coberturas']) {
      assert.ok(
        !columnas.includes(relacion),
        `${relacion} es una relación y no debería contarse como columna`
      )
    }
    // Las FKs sí deben estar
    for (const fk of ['tipo_delito_id', 'ubicacion_id', 'fuente_id']) {
      assert.ok(columnas.includes(fk), `${fk} debería estar como columna`)
    }
  })

  test('resuelve @map al nombre real de la columna', () => {
    const campos = camposEscalares(leerSchema())
    const requiere = campos.find(
      c => c.tabla === 'hechos_delictivos' && c.campo === 'requiereRevision'
    )
    assert.ok(requiere, 'debería encontrar el campo requiereRevision')
    assert.equal(requiere!.columna, 'requiere_revision')
  })
})

describe('toda columna del schema tiene respaldo en una migración', () => {
  test('ninguna columna declarada queda sin crear', () => {
    const sql = sqlDeMigraciones()
    const faltantes = camposEscalares(leerSchema()).filter(
      c => !sql.includes(`"${c.columna}"`)
    )

    const detalle = faltantes
      .map(c => `  ${c.tabla}.${c.columna} (campo ${c.modelo}.${c.campo})`)
      .join('\n')

    assert.equal(
      faltantes.length,
      0,
      `Hay columnas declaradas en schema.prisma que ninguna migración crea:\n${detalle}\n\n` +
        'Sobre una base nueva la app falla con P2022. Agregá la migración correspondiente.'
    )
  })

  test('requiere_revision quedó versionada', () => {
    // Regresión explícita del caso concreto que motivó este test.
    const sql = sqlDeMigraciones()
    assert.ok(
      sql.includes('"requiere_revision"'),
      'requiere_revision debe existir en alguna migración'
    )
  })
})

describe('las migraciones nuevas son idempotentes', () => {
  /**
   * Las migraciones que agregamos después de que la base ya existía tienen que
   * poder correr sobre producción sin fallar, porque esas columnas se aplicaron
   * a mano. Las cuatro originales sí usan CREATE TABLE sin guarda, y así debe
   * ser: crean el esquema desde cero.
   */
  const MIGRACIONES_POSTERIORES = [
    '20260804120000_add_nombre_victima',
    '20260804130000_indices_revisiones',
    '20260806120000_add_requiere_revision',
  ]

  for (const nombre of MIGRACIONES_POSTERIORES) {
    test(`${nombre} usa guardas IF NOT EXISTS`, () => {
      const ruta = path.join(DIR_MIGRACIONES, nombre, 'migration.sql')
      const contenido = readFileSync(ruta, 'utf-8')

      // Toda sentencia que cree algo debe traer su guarda.
      const sentencias = contenido
        .split('\n')
        .map(l => l.trim())
        .filter(l => /^(ALTER TABLE|CREATE INDEX|CREATE EXTENSION)/i.test(l))

      for (const s of sentencias) {
        const esAlterConAdd = /^ALTER TABLE/i.test(s)
        if (esAlterConAdd) {
          // El ADD COLUMN puede estar en la línea siguiente; se chequea el bloque.
          continue
        }
        assert.match(
          s,
          /IF NOT EXISTS/i,
          `esta sentencia debería llevar IF NOT EXISTS: ${s}`
        )
      }

      if (/ADD COLUMN/i.test(contenido)) {
        assert.match(
          contenido,
          /ADD COLUMN IF NOT EXISTS/i,
          'los ADD COLUMN deben llevar IF NOT EXISTS para ser no-op en producción'
        )
      }
    })
  }

  test('ninguna migración posterior borra datos', () => {
    // Guarda contra un DROP o TRUNCATE que se cuele en una migración.
    for (const nombre of MIGRACIONES_POSTERIORES) {
      const contenido = readFileSync(
        path.join(DIR_MIGRACIONES, nombre, 'migration.sql'),
        'utf-8'
      )
      for (const peligrosa of ['DROP TABLE', 'DROP COLUMN', 'TRUNCATE', 'DELETE FROM']) {
        assert.ok(
          !new RegExp(peligrosa, 'i').test(contenido),
          `${nombre} contiene ${peligrosa}, que destruiría datos`
        )
      }
    }
  })
})
