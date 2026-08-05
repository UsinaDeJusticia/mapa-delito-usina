import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  tieneCredencialReal,
  estaExcluida,
  buscarEnContenido,
} from '../../scripts/ci/verificar-secretos'

describe('tieneCredencialReal', () => {
  test('detecta una URL de Neon con contraseña', () => {
    assert.equal(
      tieneCredencialReal(
        "const u = 'postgresql://neondb_owner:npg_ejemploFalso123@ep-algo-123.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require'"
      ),
      true
    )
  })

  test('detecta el esquema corto postgres://', () => {
    assert.equal(
      tieneCredencialReal('postgres://admin:s3cr3tFalso@db.produccion.example.net/app'),
      true
    )
  })

  test('detecta la credencial aunque esté en medio de otro texto', () => {
    assert.equal(
      tieneCredencialReal('DATABASE_URL=postgresql://u1:pw2@host.aws.neon.tech/db # nota'),
      true
    )
  })

  // ── Falsos positivos que NO deben fallar el build ──

  test('ignora el placeholder user:pass@host de los textos de ayuda', () => {
    assert.equal(
      tieneCredencialReal(
        `echo '   export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"'`
      ),
      false
    )
  })

  test('ignora localhost sin punto', () => {
    assert.equal(
      tieneCredencialReal('postgresql://postgres:algo@localhost:5432/mapa_test'),
      false
    )
  })

  test('ignora el placeholder de CI', () => {
    assert.equal(
      tieneCredencialReal('DATABASE_URL: postgresql://ci:ci@localhost:5432/ci?schema=public'),
      false
    )
  })

  test('ignora hosts de ejemplo con punto', () => {
    assert.equal(
      tieneCredencialReal('postgresql://alguien:algo@example.com/db'),
      false
    )
  })

  test('ignora el placeholder de .env.example', () => {
    assert.equal(
      tieneCredencialReal('DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require'),
      false
    )
  })

  test('ignora una URL sin credenciales', () => {
    assert.equal(tieneCredencialReal('postgresql://ep-algo.aws.neon.tech/neondb'), false)
    assert.equal(tieneCredencialReal('https://opencode.ai/zen/go/v1'), false)
  })

  test('ignora líneas sin URL', () => {
    assert.equal(tieneCredencialReal('const x = 1'), false)
    assert.equal(tieneCredencialReal(''), false)
  })
})

describe('estaExcluida', () => {
  test('excluye .env.example, docs, .github y el lockfile', () => {
    for (const r of [
      '.env.example',
      'package-lock.json',
      'docs/plan-seguridad-performance-mantenibilidad.md',
      '.github/workflows/ci.yml',
    ]) {
      assert.equal(estaExcluida(r), true, `debería excluir ${r}`)
    }
  })

  test('no excluye código de aplicación ni scripts', () => {
    for (const r of [
      'src/lib/mapa/queries.ts',
      'scripts/pipeline/scrapear-medios.ts',
      'schema-neon.js',
      'prisma/schema.prisma',
    ]) {
      assert.equal(estaExcluida(r), false, `no debería excluir ${r}`)
    }
  })
})

describe('buscarEnContenido', () => {
  test('reporta el número de línea correcto', () => {
    const contenido = [
      'línea uno',
      'const ok = 1',
      'const url = "postgresql://u:p@real.aws.neon.tech/db"',
      'otra línea',
    ].join('\n')

    const hallazgos = buscarEnContenido('src/x.ts', contenido)
    assert.equal(hallazgos.length, 1)
    assert.deepEqual(hallazgos[0], { ruta: 'src/x.ts', linea: 3 })
  })

  test('devuelve vacío para un archivo limpio', () => {
    assert.deepEqual(buscarEnContenido('src/x.ts', 'todo bien\nsin secretos'), [])
  })

  test('reporta múltiples hallazgos', () => {
    const contenido = [
      'postgresql://a:b@uno.aws.neon.tech/db',
      'nada',
      'postgres://c:d@dos.aws.neon.tech/db',
    ].join('\n')
    assert.equal(buscarEnContenido('x', contenido).length, 2)
  })
})
