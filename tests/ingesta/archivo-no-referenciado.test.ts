/**
 * Guarda que la carpeta de archivo siga siendo archivo.
 *
 * `scripts/ingesta/archivo/` contiene scripts que no se ejecutan. El riesgo no
 * es que estén ahí, es que alguien los vuelva a enganchar a un flujo real sin
 * revisar por qué habían salido —`cargar-snic.ts`, por ejemplo, instancia su
 * propio PrismaClient y agota el pool de Neon—.
 *
 * Si un test de acá falla, la pregunta no es cómo hacerlo pasar: es si el script
 * se revivió a propósito. Si es a propósito, sacalo de `archivo/` y arreglá lo
 * que el README lista como pendiente.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const DIR_ARCHIVO = path.join(RAIZ, 'scripts', 'ingesta', 'archivo')

/** Archivos que declaran o disparan trabajo real de ingesta. */
const PUNTOS_DE_ENTRADA = [
  'package.json',
  'scripts/ingesta/run_ingesta.sh',
]

function nombresArchivados(): string[] {
  return readdirSync(DIR_ARCHIVO).filter(f => f !== 'README.md')
}

describe('la carpeta de archivo está bien formada', () => {
  test('existe y tiene un README que explica por qué', () => {
    assert.ok(existsSync(DIR_ARCHIVO), 'falta scripts/ingesta/archivo/')
    const readme = readFileSync(path.join(DIR_ARCHIVO, 'README.md'), 'utf-8')
    assert.match(readme, /no se ejecuta/i, 'el README debe decir que no se ejecutan')
  })

  test('cada script archivado está documentado en el README', () => {
    const readme = readFileSync(path.join(DIR_ARCHIVO, 'README.md'), 'utf-8')
    for (const nombre of nombresArchivados()) {
      assert.ok(
        readme.includes(nombre),
        `${nombre} está archivado pero el README no explica por qué`
      )
    }
  })
})

describe('ningún punto de entrada invoca código archivado', () => {
  for (const entrada of PUNTOS_DE_ENTRADA) {
    test(`${entrada} no referencia scripts archivados`, () => {
      const contenido = readFileSync(path.join(RAIZ, entrada), 'utf-8')
      for (const nombre of nombresArchivados()) {
        assert.ok(
          !contenido.includes(nombre),
          `${entrada} volvió a invocar ${nombre}, que está archivado. ` +
          'Leé scripts/ingesta/archivo/README.md antes de revivirlo.'
        )
      }
    })
  }
})

describe('nada del código de la app importa lo archivado', () => {
  test('src/ no importa desde scripts/ingesta/archivo', () => {
    const sospechosos: string[] = []

    function recorrer(dir: string) {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name)
        if (entrada.isDirectory()) {
          recorrer(completo)
        } else if (/\.tsx?$/.test(entrada.name)) {
          const contenido = readFileSync(completo, 'utf-8')
          if (/ingesta\/archivo/.test(contenido)) {
            sospechosos.push(path.relative(RAIZ, completo))
          }
        }
      }
    }

    recorrer(path.join(RAIZ, 'src'))
    assert.deepEqual(
      sospechosos,
      [],
      'código de la aplicación importando un script archivado de ingesta'
    )
  })
})
