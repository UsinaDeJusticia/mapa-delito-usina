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
  test('el Prompt 2 pide más de 500 tokens', () => {
    // El JSON pedido incluye resumen_hecho ("un párrafo") y el validador tolera
    // 4000 chars ahí, así que la salida esperada son 300-500 tokens: 500 dejaba
    // el techo justo encima del caso normal.
    const src = leer('src/lib/mapa/openrouter.ts')
    const m = src.match(/max_tokens:\s*(\d+)/)
    assert.ok(m, 'no encontré max_tokens en openrouter.ts')
    assert.ok(
      Number(m![1]) >= 1000,
      `max_tokens quedó en ${m![1]}: muy justo para el JSON que pide el prompt`
    )
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
