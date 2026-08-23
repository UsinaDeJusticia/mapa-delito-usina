/**
 * El resumen final del pipeline suma tiempo por fase (browser / identificación
 * LLM / extracción LLM / dedup) y cuenta llamadas al LLM por tipo.
 *
 * POR QUÉ IMPORTA
 * Antes del cambio, el único resumen era conteos (`noticiasScrapeadas`,
 * `hechosNuevos`, `duplicados`, ...) sin ningún tiempo. El diagnóstico de la
 * corrida del 22/8 (79 min, 66 medios) tuvo que reconstruirse a mano a partir
 * del espaciado de timestamps en los logs — nada quedaba calculado. Este test
 * fija que los acumuladores existen, que se alimentan en los puntos correctos
 * (browser, identificación, extracción, dedup) y que llegan al resumen final.
 *
 * NO SE TESTEA POR EJECUCIÓN REAL
 * `scrapear-medios.ts` llama a `main()` al importarse (es un script, no un
 * módulo), así que no se puede requerir en un test sin correr el pipeline
 * completo contra una base real. Por eso, igual que
 * coherencia-prompt-validador.test.ts, este test analiza el código fuente:
 * confirma que cada punto de instrumentación existe y que la escritura del
 * acumulador ocurre junto al `await` de la operación que mide, no en un lugar
 * arbitrario del archivo.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const SCRAPER = readFileSync(path.join(RAIZ, 'scripts/pipeline/scrapear-medios.ts'), 'utf-8')
const LLAMADA_LLM = readFileSync(path.join(RAIZ, 'src/lib/pipeline/llamada-llm.ts'), 'utf-8')

describe('acumulador de métricas por fase', () => {
  test('existe un acumulador con las cuatro fases y el conteo de llamadas al LLM', () => {
    assert.match(SCRAPER, /tiempoBrowserMs\s*:\s*0/, 'falta el acumulador de tiempo de browser')
    assert.match(SCRAPER, /tiempoIdentificacionLLMMs\s*:\s*0/, 'falta el acumulador de identificación')
    assert.match(SCRAPER, /tiempoExtraccionLLMMs\s*:\s*0/, 'falta el acumulador de extracción')
    assert.match(SCRAPER, /tiempoDedupMs\s*:\s*0/, 'falta el acumulador de dedup')
    assert.match(SCRAPER, /llamadasLLM\s*:\s*\{/, 'falta el contador de llamadas al LLM')
  })
})

describe('cada fase se mide junto a la operación real, no en otro lugar del archivo', () => {
  test('ab() (todas las llamadas a agent-browser) acumula tiempo de browser', () => {
    // ab() es el único punto por el que pasan snapshot/click/wait/getUrl/etc,
    // así que medir ahí cubre toda la fase sin instrumentar cada llamador.
    const cuerpoAb = SCRAPER.slice(
      SCRAPER.indexOf('function ab('),
      SCRAPER.indexOf('function ab(') + 500
    )
    assert.match(cuerpoAb, /const inicio = Date\.now\(\)/, 'ab() no marca el inicio')
    assert.match(
      cuerpoAb,
      /metricas\.tiempoBrowserMs \+= Date\.now\(\) - inicio/,
      'ab() no acumula el tiempo de browser tras ejecutarBrowser'
    )
    // El acumulador tiene que sumar DESPUÉS de invocar ejecutarBrowser, no antes
    // (si no, mide 0 siempre).
    const posEjecutar = cuerpoAb.indexOf('ejecutarBrowser(')
    const posAcumula = cuerpoAb.indexOf('metricas.tiempoBrowserMs +=')
    assert.ok(posEjecutar > 0 && posAcumula > posEjecutar, 'se acumula antes de ejecutar el comando')
  })

  test('identificarNoticiasConIA se mide en su call site y cuenta como llamada LLM', () => {
    const posLlamada = SCRAPER.indexOf('await identificarNoticiasConIA(')
    assert.ok(posLlamada > 0, 'no se encontró la llamada a identificarNoticiasConIA')
    const alrededor = SCRAPER.slice(posLlamada - 200, posLlamada + 300)
    assert.match(alrededor, /const inicioIdentificacion = Date\.now\(\)/)
    assert.match(alrededor, /metricas\.tiempoIdentificacionLLMMs \+= Date\.now\(\) - inicioIdentificacion/)
    assert.match(alrededor, /metricas\.llamadasLLM\.identificacion\+\+/)
  })

  test('extraerDatosNoticia se mide en su call site y cuenta como llamada LLM', () => {
    const posLlamada = SCRAPER.indexOf('await extraerDatosNoticia(')
    assert.ok(posLlamada > 0, 'no se encontró la llamada a extraerDatosNoticia')
    const alrededor = SCRAPER.slice(posLlamada - 200, posLlamada + 300)
    assert.match(alrededor, /const inicioExtraccion = Date\.now\(\)/)
    assert.match(alrededor, /metricas\.tiempoExtraccionLLMMs \+= Date\.now\(\) - inicioExtraccion/)
    assert.match(alrededor, /metricas\.llamadasLLM\.extraccion\+\+/)
  })

  test('deduplicar se mide en su call site', () => {
    const posLlamada = SCRAPER.indexOf('await deduplicar({')
    assert.ok(posLlamada > 0, 'no se encontró la llamada a deduplicar')
    const alrededor = SCRAPER.slice(posLlamada - 200, posLlamada + 900)
    assert.match(alrededor, /const inicioDedup = Date\.now\(\)/)
    assert.match(alrededor, /metricas\.tiempoDedupMs \+= Date\.now\(\) - inicioDedup/)
  })

  test('el resumen final incluye los tiempos por fase y las llamadas al LLM', () => {
    const posResumen = SCRAPER.indexOf("'Resumen:'")
    assert.ok(posResumen > 0, 'no se encontró el log del resumen final')
    const bloqueResumen = SCRAPER.slice(posResumen, posResumen + 900)
    assert.match(bloqueResumen, /tiemposMs\s*:\s*\{/, 'el resumen no incluye tiemposMs')
    assert.match(bloqueResumen, /browser\s*:\s*metricas\.tiempoBrowserMs/)
    assert.match(bloqueResumen, /identificacionLLM\s*:\s*metricas\.tiempoIdentificacionLLMMs/)
    assert.match(bloqueResumen, /extraccionLLM\s*:\s*metricas\.tiempoExtraccionLLMMs/)
    assert.match(bloqueResumen, /dedup\s*:\s*metricas\.tiempoDedupMs/)
    assert.match(bloqueResumen, /llamadasLLM\s*:\s*\{/, 'el resumen no incluye el conteo de llamadas al LLM')
  })
})

describe('llamada-llm.ts no se toca en este cambio', () => {
  test('llamada-llm.ts no importa ni referencia el acumulador de métricas del scraper', () => {
    // Otro agente trabaja en paralelo sobre este archivo — instrumentar las
    // métricas ahí habría generado un conflicto de merge innecesario.
    assert.doesNotMatch(LLAMADA_LLM, /metricas\.tiempo/, 'llamada-llm.ts quedó acoplado al acumulador del scraper')
  })
})
