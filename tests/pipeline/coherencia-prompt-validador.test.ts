/**
 * El Prompt 1 pide exactamente lo que el validador acepta.
 *
 * EL DEFECTO QUE ESTE TEST FIJA
 * El prompt de identificación de links pedía
 * `{"ref": "ID_O_URL_DEL_LINK", "titulo": "..."}` — el placeholder invitaba
 * literalmente a devolver una URL — mientras `validarLinksIdentificados` solo
 * acepta `^e[0-9]+$`, que es el formato de ref de agent-browser. Cuando el
 * modelo tomaba la opción "URL", el validador descartaba TODAS las entradas.
 *
 * Pasó de verdad: El Independiente La Rioja identificó 10 noticias y se
 * descartaron las 10, todas con "ref no cumple ^e[0-9]+$". En el resumen de la
 * corrida eso se veía como "0 noticias identificadas", indistinguible de "no
 * había homicidios en ese medio".
 *
 * POR QUÉ EL TEST FALTABA
 * El defecto no vivía en ninguno de los dos archivos: vivía en el hueco entre
 * ellos. Cada pieza era correcta por separado y nadie las comparaba. Esta suite
 * es esa comparación.
 *
 * Nota deliberada: la corrección va del lado del prompt. El `^e[0-9]+$` NO se
 * relaja — ese ref se interpola en un comando (ver el comentario sobre la ruta
 * LLM → shell en scrapear-medios.ts), así que la estrechez es una defensa.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { validarLinksIdentificados } from '../../src/lib/pipeline/schemas-llm'

const RAIZ = process.cwd()
const SCRAPER = readFileSync(path.join(RAIZ, 'scripts/pipeline/scrapear-medios.ts'), 'utf-8')

/** El bloque del prompt que describe la salida, que es donde estaba el defecto. */
function bloqueFormato(): string {
  const inicio = SCRAPER.indexOf('FORMATO DE SALIDA')
  assert.ok(inicio > 0, 'no se encontró el bloque de formato del Prompt 1')
  const fin = SCRAPER.indexOf('Máximo 10 resultados', inicio)
  assert.ok(fin > inicio, 'no se encontró el cierre del bloque de formato')
  return SCRAPER.slice(inicio, fin)
}

/** Los ejemplos de `ref` que el prompt le muestra al modelo. */
function refsDelEjemplo(): string[] {
  return [...bloqueFormato().matchAll(/"ref":\s*"([^"]*)"/g)].map(m => m[1])
}

describe('el ejemplo del prompt pasa el validador', () => {
  test('hay al menos un ejemplo de ref en el prompt', () => {
    assert.ok(refsDelEjemplo().length > 0, 'el prompt dejó de mostrar un ejemplo de ref')
  })

  test('cada ref de ejemplo sobrevive validarLinksIdentificados', () => {
    // El corazón del test: se le pasa al validador real lo mismo que el prompt
    // le muestra al modelo. Si divergen, esto falla.
    for (const ref of refsDelEjemplo()) {
      const { links, descartados } = validarLinksIdentificados([
        { ref, titulo: 'Un titular cualquiera' },
      ])
      assert.deepEqual(
        descartados,
        [],
        `el prompt muestra ref="${ref}" como ejemplo, pero el validador lo descarta`
      )
      assert.equal(links.length, 1)
    }
  })

  test('el prompt no ofrece una URL como ref', () => {
    const bloque = bloqueFormato()
    assert.ok(
      !/ID_O_URL_DEL_LINK/.test(bloque),
      'volvió el placeholder que invitaba a devolver una URL'
    )
    for (const ref of refsDelEjemplo()) {
      assert.ok(
        !/https?:|\//.test(ref),
        `el ejemplo de ref parece una URL o una ruta: "${ref}"`
      )
    }
  })

  test('el prompt dice explícitamente que el ref se copia textual del snapshot', () => {
    // Sin esta instrucción, un snapshot cortado a la mitad de un ref empuja al
    // modelo a improvisar uno — y la entrada se descarta.
    const bloque = bloqueFormato()
    assert.match(bloque, /TEXTUAL|textual/, 'falta la instrucción de copiar el ref tal cual')
    assert.match(bloque, /NUNCA pongas una URL/, 'falta la prohibición explícita de usar URLs')
  })
})

describe('el validador sigue siendo estrecho: es una defensa, no un detalle', () => {
  test('rechaza una URL en el campo ref', () => {
    const { links, descartados } = validarLinksIdentificados([
      { ref: 'https://elindependiente.com.ar/nota/123', titulo: 'x' },
    ])
    assert.equal(links.length, 0)
    assert.equal(descartados.length, 1)
  })

  test('rechaza un ref con metacaracteres de shell', () => {
    // El motivo real del ^e[0-9]+$: ese valor termina en un comando.
    for (const hostil of ['e1; rm -rf /', 'e1 && curl evil', '$(whoami)', 'e1`id`']) {
      const { links } = validarLinksIdentificados([{ ref: hostil, titulo: 'x' }])
      assert.equal(links.length, 0, `pasó un ref hostil: ${hostil}`)
    }
  })
})

describe('los recortes de entrada tienen el motivo escrito al lado', () => {
  // No son constantes cosméticas: bajarlas vuelve a perder noticias. La guarda
  // es contra un "optimicemos el costo" sin leer los prompt_tokens reales.
  test('el snapshot se manda con SNAPSHOT_MAX_CHARS, no un literal', () => {
    // Tiene que ser una constante nombrada y overrideable por env var: el 20/8
    // se necesitó variar este valor por medio desde workflow_dispatch para
    // medir latencia/completion_tokens sin editar código entre corridas.
    assert.match(
      SCRAPER,
      /snapshot\.slice\(0,\s*SNAPSHOT_MAX_CHARS\)/,
      'el snapshot volvió a mandarse con un número hardcodeado en vez de la constante'
    )
  })

  test('SNAPSHOT_MAX_CHARS default 30000, overrideable por PIPELINE_SNAPSHOT_MAX_CHARS', () => {
    assert.match(
      SCRAPER,
      /const SNAPSHOT_MAX_CHARS = Number\(process\.env\.PIPELINE_SNAPSHOT_MAX_CHARS\) \|\| 30000/,
      'bajó el default o dejó de ser overrideable: los refs solo existen en el snapshot, cortarlo pierde enlaces'
    )
  })

  test('el cuerpo de la nota se guarda con margen sobre lo que se envía', () => {
    const openrouter = readFileSync(path.join(RAIZ, 'src/lib/mapa/openrouter.ts'), 'utf-8')
    const m = openrouter.match(/export const MAX_CHARS_NOTICIA = (\d+)/)
    assert.ok(m, 'desapareció MAX_CHARS_NOTICIA')
    const enviado = Number(m![1])
    const guardado = Number(SCRAPER.match(/texto\.trim\(\)\.slice\(0,\s*(\d+)\)/)![1])
    assert.ok(
      guardado >= enviado,
      `se guardan ${guardado} chars y se envían ${enviado}: no se puede leer lo que no se guardó`
    )
    assert.ok(enviado >= 6000, `el envío bajó a ${enviado} chars`)
  })
})

describe('un medio perdido completo se distingue de un medio sin noticias', () => {
  test('el log grita cuando se descartan todas las entradas', () => {
    // Era el agujero de observabilidad que hizo que La Rioja pasara inadvertida
    // durante toda una corrida.
    assert.match(
      SCRAPER,
      /SE DESCARTARON LAS \$\{descartados\.length\} ENTRADAS/,
      'volvió a perderse la distinción entre "descarté algunas" y "descarté todas"'
    )
  })
})

describe('workflow_dispatch de pipeline.yml permite experimentar sin tocar producción', () => {
  // El 20/8 subir el snapshot a 30000 disparó una corrida de ~5h estimadas
  // (deepseek-v4-flash gasta el presupuesto de salida en tokens de reasoning
  // cuando el contexto es grande) y quedó casi 2h colgada sin que nada la
  // cortara. Estos tests fijan las dos salvaguardas que se agregaron: poder
  // medir un solo medio sin escribir a la base, y un timeout que corte un job
  // realmente colgado en vez de dejarlo horas en silencio.
  const YML = readFileSync(path.join(RAIZ, '.github/workflows/pipeline.yml'), 'utf-8')

  test('tiene timeout-minutes en el job', () => {
    assert.match(YML, /timeout-minutes:\s*\d+/, 'sin esto un job colgado corre hasta las 6h de default')
  })

  test('el cron programado no manda inputs: sigue corriendo igual que siempre', () => {
    // Los inputs de workflow_dispatch no existen en un trigger schedule, así
    // que el guard github.event_name == 'workflow_dispatch' es lo que
    // garantiza que la corrida diaria no cambia de comportamiento.
    assert.match(YML, /github\.event_name == 'workflow_dispatch'/)
  })

  test('acepta medio, snapshot_max_chars y dry_run como inputs', () => {
    for (const input of ['medio:', 'snapshot_max_chars:', 'dry_run:']) {
      assert.ok(YML.includes(input), `falta el input ${input}`)
    }
  })

  test('dry_run default true: un experimento no escribe a producción por accidente', () => {
    const bloque = YML.slice(YML.indexOf('dry_run:'), YML.indexOf('jobs:'))
    assert.match(bloque, /default:\s*true/)
  })
})
