/**
 * El chequeo de "¿esta URL ya está en la base?" tiene que ocurrir ANTES de la
 * extracción de texto y de la llamada de extracción al LLM, no después.
 *
 * EL DEFECTO QUE ESTE TEST FIJA
 * Antes, `deduplicar()` hacía ese chequeo como su paso 1 — pero se llamaba
 * DESPUÉS de `extraerDatosNoticia()`. En la corrida de producción del 22/8,
 * 32 de 72 llamadas de extracción (44%) terminaban descartadas por "URL ya
 * procesada": se pagaba (y se tiraba) texto extraído con selectores + una
 * llamada completa al LLM para descubrir algo que ya se sabía apenas se
 * conoció la URL del artículo. El fix mueve el chequeo a scrapearMedio, justo
 * después de validar el destino del click (esDestinoPermitido) y antes de
 * tocar el DOM para extraer contenido.
 *
 * POR QUÉ ESTE TEST NO ES UN includes() SOBRE EL ARCHIVO
 * Un `includes('urlYaRegistrada')` pasaría aunque el chequeo se agregara en
 * cualquier lugar del archivo, incluso después de la extracción — no probaría
 * nada sobre el ORDEN real de ejecución. Este test compara la POSICIÓN de la
 * llamada a `urlYaRegistrada` contra la de `extraerDatosNoticia` en el código
 * fuente. Como ambas viven en el mismo módulo secuencial (scrapearMedio corre
 * antes, medio por medio, y solo después arranca el loop de extracción), la
 * posición en el texto SÍ refleja el orden de ejecución acá — no sería válido
 * en un archivo con funciones reordenables o control de flujo asíncrono
 * complejo, pero es exactamente lo que hay en este script.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const SCRAPER = readFileSync(path.join(RAIZ, 'scripts/pipeline/scrapear-medios.ts'), 'utf-8')

function indiceDe(patron: RegExp, motivo: string): number {
  const m = SCRAPER.match(patron)
  assert.ok(m && m.index !== undefined, motivo)
  return m!.index!
}

describe('el chequeo de URL duplicada corre antes de la extracción por LLM', () => {
  test('urlYaRegistrada se importa desde el deduplicador (helper único, no una query duplicada a mano)', () => {
    assert.match(
      SCRAPER,
      /import\s*\{[^}]*urlYaRegistrada[^}]*\}\s*from\s*['"]\.\.\/\.\.\/src\/lib\/mapa\/deduplicador['"]/,
      'el scraper dejó de importar el helper compartido — riesgo de que la query diverja entre los dos lugares'
    )
  })

  test('la llamada a urlYaRegistrada aparece ANTES que la llamada a extraerDatosNoticia', () => {
    const posicionChequeoTemprano = indiceDe(
      /await urlYaRegistrada\(/,
      'no se encontró la llamada "await urlYaRegistrada(" — ¿se removió el chequeo temprano?'
    )
    const posicionExtraccionLLM = indiceDe(
      /await extraerDatosNoticia\(/,
      'no se encontró la llamada de extracción — ¿cambió de nombre?'
    )
    assert.ok(
      posicionChequeoTemprano < posicionExtraccionLLM,
      'el chequeo de URL duplicada quedó DESPUÉS de la llamada de extracción: eso es exactamente el desperdicio del 44% que este cambio vino a eliminar'
    )
  })

  test('el chequeo temprano corre después de validar el destino (esDestinoPermitido) y antes de extraer título/texto', () => {
    const posicionDestino = indiceDe(
      /esDestinoPermitido\(urlArticulo\)/,
      'no se encontró la validación de destino tras el click'
    )
    const posicionChequeoTemprano = indiceDe(/await urlYaRegistrada\(/, 'no se encontró urlYaRegistrada(')
    const posicionGetTitulo = indiceDe(
      /ab\(comandos\.getTitulo\(\)\)/,
      'no se encontró la obtención de título — ¿cambió el flujo de extracción?'
    )
    assert.ok(
      posicionDestino < posicionChequeoTemprano,
      'el chequeo de duplicado corre antes de saber a qué URL aterrizó el click'
    )
    assert.ok(
      posicionChequeoTemprano < posicionGetTitulo,
      'el chequeo de duplicado quedó después de empezar a extraer título/texto: no se ahorra nada'
    )
  })

  test('al detectar duplicado temprano, cierra la tab y hace continue sin extraer texto', () => {
    const bloque = SCRAPER.slice(
      SCRAPER.search(/if \(await urlYaRegistrada\(urlArticulo\)\) \{/),
      SCRAPER.search(/if \(await urlYaRegistrada\(urlArticulo\)\) \{/) + 400
    )
    assert.match(bloque, /cerrarTab/, 'no cierra la tab de detalle antes de continuar')
    assert.match(bloque, /tab\(0\)/, 'no vuelve a la tab 0 antes de continuar')
    assert.match(bloque, /continue/, 'no hace continue: seguiría a extraer texto igual')
  })

  test('deduplicar() sigue haciendo su propio chequeo de URL (no se le quitó la salvaguarda)', () => {
    const deduplicadorSrc = readFileSync(
      path.join(RAIZ, 'src/lib/mapa/deduplicador.ts'),
      'utf-8'
    )
    assert.match(
      deduplicadorSrc,
      /export async function deduplicar/,
      'deduplicar() dejó de existir'
    )
    assert.match(
      deduplicadorSrc,
      /export async function urlYaRegistrada/,
      'no se exportó urlYaRegistrada desde el deduplicador'
    )
    // deduplicar sigue delegando en la misma consulta que usa urlYaRegistrada,
    // para que ambos caminos no puedan divergir.
    assert.match(
      deduplicadorSrc,
      /buscarCoberturaPorUrl/,
      'deduplicar() y urlYaRegistrada() dejaron de compartir la misma consulta'
    )
  })
})
