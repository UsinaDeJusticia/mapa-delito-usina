/**
 * Test del optimizador de imágenes de Next.js.
 *
 * El proyecto no usa `next/image` en ningún archivo, así que el optimizador
 * `/_next/image` (que procesa cualquier URL con `sharp`/libvips) queda
 * expuesto sin ningún uso real. `next.config.mjs` lo apaga con
 * `images: { unoptimized: true }`.
 *
 * Este test protege dos cosas:
 * 1. Que esa opción siga presente (que no se pierda en un refactor del config).
 * 2. Que nadie reintroduzca `next/image` sin revisar la decisión — si alguien
 *    lo agrega, este test falla y obliga a decidir a propósito si corresponde
 *    volver a prender el optimizador.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()

function listarArchivosRecursivo(dir: string): string[] {
  const resultado: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const rutaCompleta = path.join(dir, entrada.name)
    if (entrada.isDirectory()) {
      resultado.push(...listarArchivosRecursivo(rutaCompleta))
    } else if (entrada.isFile()) {
      resultado.push(rutaCompleta)
    }
  }
  return resultado
}

describe('optimizador de imágenes de Next.js', () => {
  test('next.config.mjs desactiva el optimizador con unoptimized: true', () => {
    const config = readFileSync(path.join(RAIZ, 'next.config.mjs'), 'utf-8')
    assert.match(
      config,
      /images:\s*\{[^}]*unoptimized:\s*true/,
      'falta `images: { unoptimized: true }` en next.config.mjs'
    )
  })

  test('no hay ningún uso de next/image en src/', () => {
    const archivos = listarArchivosRecursivo(path.join(RAIZ, 'src')).filter((f) =>
      /\.(tsx?|jsx?|mjs)$/.test(f)
    )
    const conNextImage: string[] = []
    for (const archivo of archivos) {
      const contenido = readFileSync(archivo, 'utf-8')
      if (/from\s+['"]next\/image['"]/.test(contenido)) {
        conNextImage.push(path.relative(RAIZ, archivo))
      }
    }
    assert.deepEqual(
      conNextImage,
      [],
      `se encontró un import de next/image (${conNextImage.join(', ')}) — con el ` +
      'optimizador apagado (unoptimized: true) no tiene sentido usar next/image ' +
      'en vez de <img>; si esto es intencional, revisar si conviene sacar ' +
      'unoptimized y volver a habilitar el optimizador.'
    )
  })
})
