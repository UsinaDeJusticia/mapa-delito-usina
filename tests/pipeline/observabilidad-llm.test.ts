/**
 * Guarda estructural: los tres consumidores del LLM pasan por
 * obtenerContenidoLLM(), y ninguno vuelve a tragarse un fallo en silencio.
 *
 * POR QUÉ HACE FALTA UNA GUARDA Y NO ALCANZAN LOS TESTS DE UNIDAD
 * Los tests de `llamada-llm.test.ts` prueban que el módulo funciona. Esto
 * prueba que se USA en los tres lugares. Son cosas distintas: el defecto
 * original no era que el reintento estuviera mal implementado, era que no
 * existía en ninguno de los tres. Si mañana alguien agrega un cuarto consumidor
 * o revierte uno a `chat.completions.create` directo, el bug vuelve sin que
 * ningún test de unidad se entere.
 *
 * El caso más peligroso es el de `scrapear-medios.ts`: tenía
 * `content?.trim() || '[]'`, así que una respuesta vacía se convertía en "este
 * medio no tiene noticias" sin un solo log. En los logs quedaba idéntico a
 * "revisé y no había homicidios", y con ~45 medios devolviendo casi todos "0
 * noticias", esa confusión tapaba el problema entero.
 */

import { MAX_TOKENS_LLM } from '../../src/lib/pipeline/limites-llm'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()

const CONSUMIDORES = [
  'src/lib/mapa/openrouter.ts',
  'src/lib/mapa/deduplicador.ts',
  'scripts/pipeline/scrapear-medios.ts',
] as const

function leer(rel: string): string {
  return readFileSync(path.join(RAIZ, rel), 'utf-8')
}

/**
 * Quita las líneas que son solo comentario.
 *
 * Hace falta porque estos tests buscan patrones de código que NO deben volver,
 * y los comentarios del propio código documentan a propósito cuáles eran. Sin
 * esto, la advertencia que respalda el fix hace fallar el test.
 *
 * Filtra líneas enteras y no ocurrencias de `//`, para no romper las URLs.
 */
function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('los tres consumidores del LLM usan el helper con reintento', () => {
  for (const rel of CONSUMIDORES) {
    const src = leer(rel)

    test(`${rel} importa obtenerContenidoLLM`, () => {
      assert.match(src, /obtenerContenidoLLM/, `${rel} tiene que usar el helper compartido`)
    })

    test(`${rel} no llama a chat.completions.create sin envolverlo`, () => {
      // La llamada tiene que estar dentro del `ejecutar:` del helper, para que
      // el reintento y el diagnóstico apliquen. Un `await cliente.chat...`
      // directo significa que ese camino quedó sin ninguna de las dos cosas.
      assert.ok(
        !/await\s+cliente\.chat\.completions\.create/.test(sinComentarios(src)),
        `${rel} volvió a llamar al LLM directo: ese camino no reintenta ni deja diagnóstico`
      )
    })
  }
})

describe('el bug de la pérdida silenciosa de medios no vuelve', () => {
  const src = leer('scripts/pipeline/scrapear-medios.ts')
  const codigo = sinComentarios(src)

  test('no queda el fallback a array vacío que ocultaba el fallo', () => {
    assert.ok(
      !/content\?\.trim\(\)\s*\|\|\s*'\[\]'/.test(codigo),
      "volvió `content?.trim() || '[]'`: una respuesta vacía se vuelve " +
        '"no hay noticias" sin log, y se pierde el medio entero en silencio'
    )
  })

  test('distingue explícitamente "sin respuesta" de "no hay noticias"', () => {
    assert.match(
      src,
      /SIN RESPUESTA USABLE/,
      'el log tiene que dejar claro que no es lo mismo que no haber encontrado nada'
    )
  })
})

describe('los límites de salida dejaron de estar al borde', () => {
  // deepseek-v4.1-flash razona dentro de max_tokens: con 800 / 1500 / 600 se
  // gastaba todo pensando y devolvía vacío (Infobae, 19/11/2026).
  test('los techos dejan lugar al razonamiento además de la respuesta', () => {
    assert.ok(MAX_TOKENS_LLM.identificacion >= 8000, 'identificación')
    assert.ok(MAX_TOKENS_LLM.extraccion >= 6000, 'extracción')
    assert.ok(MAX_TOKENS_LLM.deduplicacion >= 3000, 'deduplicación')
  })

  test('las tres llamadas usan los techos centralizados, no números sueltos', () => {
    for (const archivo of ['scripts/pipeline/scrapear-medios.ts', 'src/lib/mapa/openrouter.ts', 'src/lib/mapa/deduplicador.ts']) {
      const src = leer(archivo)
      assert.match(src, /max_tokens:\s*MAX_TOKENS_LLM\./, archivo)
      assert.doesNotMatch(src, /max_tokens:\s*\d+/, `${archivo} tiene un max_tokens numérico`)
    }
  })
})

describe('los ejemplos few-shot no inundan el contexto', () => {
  const src = leer('src/lib/mapa/openrouter.ts')

  test('el resumen del ejemplo se recorta', () => {
    assert.match(
      src,
      /slice\(0,\s*MAX_CHARS_EJEMPLO\)/,
      'sin tope, tres ejemplos podían aportar ~4000 tokens y diluir la instrucción de formato'
    )
  })

  test('el tope es razonable', async () => {
    const { MAX_CHARS_EJEMPLO } = await import('../../src/lib/mapa/openrouter')
    assert.ok(MAX_CHARS_EJEMPLO > 0 && MAX_CHARS_EJEMPLO <= 1000)
  })
})
