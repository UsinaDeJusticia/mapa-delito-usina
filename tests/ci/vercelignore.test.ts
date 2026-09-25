/**
 * Lo que compila la app tiene que llegar al deploy de Vercel.
 *
 * .vercelignore deja afuera del deploy carpetas como scripts/ y docs/. La CI de
 * GitHub compila con el repo completo, así que un import desde src/ hacia una
 * de ellas pasa la CI y rompe recién el build de Vercel ("Module not found").
 * Pasó en el PR #39: el panel del pipeline importaba la lista de medios desde
 * scripts/pipeline/ y el deploy de producción habría fallado.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// process.cwd() en vez de import.meta.dirname: tsx transpila a CJS (ver
// tests/prisma/coherencia-schema-migraciones.test.ts).
const RAIZ = process.cwd()

/**
 * Patrón de .vercelignore (sintaxis de .gitignore) → regex sobre rutas
 * relativas a la raíz. Cubre lo que usa el archivo: nombres sueltos, que valen
 * a cualquier profundidad (`scripts/` también saca `src/x/scripts/`), rutas
 * con barra en el medio, ancladas a la raíz (`data/snic/`), y `*` / `?`.
 */
function patronARegex(linea: string): RegExp {
  const sinBarraFinal = linea.replace(/\/$/, '')
  const anclado = sinBarraFinal.includes('/')
  const cuerpo = sinBarraFinal
    .replace(/^\//, '')
    .split('')
    .map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`${anclado ? '^' : '(^|/)'}${cuerpo}(/|$)`)
}

function patronesIgnorados(contenido: string): RegExp[] {
  return contenido
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(patronARegex)
}

const ESPECIFICADORES = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Imports relativos o con el alias `@/`, resueltos a rutas relativas a la raíz. */
function importsLocales(archivo: string, codigo: string): string[] {
  const rutas: string[] = []
  for (const patron of ESPECIFICADORES) {
    for (const m of codigo.matchAll(patron)) {
      const spec = m[1]
      let absoluta: string | null = null
      if (spec.startsWith('./') || spec.startsWith('../')) absoluta = path.resolve(path.dirname(archivo), spec)
      else if (spec.startsWith('@/')) absoluta = path.join(RAIZ, 'src', spec.slice(2))
      if (absoluta) rutas.push(path.relative(RAIZ, absoluta).split(path.sep).join('/'))
    }
  }
  return rutas
}

/** Imports que no van a existir en el deploy: fuera del repo o en una ruta ignorada. */
function importsFueraDelDeploy(archivo: string, codigo: string, patrones: RegExp[]): string[] {
  return importsLocales(archivo, codigo).filter(
    rel => rel.startsWith('../') || patrones.some(p => p.test(rel))
  )
}

function archivosDeCodigo(dir: string): string[] {
  const encontrados: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, entrada.name)
    if (entrada.isDirectory()) encontrados.push(...archivosDeCodigo(ruta))
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entrada.name)) encontrados.push(ruta)
  }
  return encontrados
}

const patrones = patronesIgnorados(readFileSync(path.join(RAIZ, '.vercelignore'), 'utf8'))

describe('.vercelignore', () => {
  test('entiende los patrones del archivo', () => {
    const ignorada = (rel: string) => patrones.some(p => p.test(rel))
    assert.equal(ignorada('scripts/pipeline/medios-config'), true)
    assert.equal(ignorada('docs/agente-local.md'), true)
    assert.equal(ignorada('src/config/medios-pipeline'), false)
    assert.equal(ignorada('src/lib/pipeline/corridas'), false)
    assert.equal(patronARegex('data/snic/').test('data/snic/2024.csv'), true)
    assert.equal(patronARegex('data/snic/').test('src/data/snic/x'), false, 'con barra en el medio se ancla a la raíz')
    assert.equal(patronARegex('scripts/').test('src/x/scripts/y'), true, 'sin barra vale a cualquier profundidad')
  })

  test('detecta el import que rompió el deploy del PR #39', () => {
    const archivo = path.join(RAIZ, 'src/app/api/admin/pipeline/route.ts')
    const codigo = "import { MEDIOS } from '../../../../../scripts/pipeline/medios-config'"
    assert.deepEqual(importsFueraDelDeploy(archivo, codigo, patrones), ['scripts/pipeline/medios-config'])
    assert.deepEqual(
      importsFueraDelDeploy(archivo, "import { MEDIOS } from '@/config/medios-pipeline'", patrones),
      []
    )
  })

  test('nada de src/ ni de next.config.mjs importa algo que Vercel no sube', () => {
    const archivos = [...archivosDeCodigo(path.join(RAIZ, 'src')), path.join(RAIZ, 'next.config.mjs')]
    let revisados = 0
    const problemas: string[] = []
    for (const archivo of archivos) {
      const codigo = readFileSync(archivo, 'utf8')
      revisados += importsLocales(archivo, codigo).length
      for (const rel of importsFueraDelDeploy(archivo, codigo, patrones)) {
        problemas.push(`${path.relative(RAIZ, archivo)} → ${rel}`)
      }
    }
    assert.ok(revisados > 100, `se esperaban muchos imports locales y se encontraron ${revisados}`)
    assert.deepEqual(problemas, [], 'mover lo compartido a src/ (como src/config/medios-pipeline.ts)')
  })
})
