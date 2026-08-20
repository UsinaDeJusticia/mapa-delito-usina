/**
 * La clasificación `violencia_policial` existe de punta a punta.
 *
 * EL ESTADO ANTERIOR — incoherente consigo mismo
 * El valor ya era válido en el CHECK de revisiones_pipeline, así que se podía
 * guardar. Pero no estaba en el mapeo compartido, y eso producía TRES
 * comportamientos distintos para el mismo dato:
 *
 *   - `efectoDeClasificacion` caía al FALLBACK → el POST lo trataba como "no es
 *     homicidio": degradaba el caso a PRELIMINAR y le limpiaba el femicidio.
 *   - La UI lo pintaba verde ✓ como homicidio, porque usaba la heurística
 *     negativa `!== 'no_es_homicidio'`.
 *   - El pin seguía apareciendo en el mapa, porque el filtro solo miraba el
 *     literal 'no_es_homicidio'.
 *
 * LA DECISIÓN
 * Código 1 (homicidio doloso). Una muerte por violencia institucional es un
 * homicidio, y el prompt del scraper ya la lista como criterio de inclusión
 * ("gatillo fácil"). No hace falta una columna nueva para no perder el matiz:
 * revisiones_pipeline.clasificacion_humana guarda el valor exacto para siempre.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  efectoDeClasificacion,
  esHomicidioSegunClasificacion,
} from '../../src/lib/mapa/clasificacion-humana'

const RAIZ = process.cwd()
const leer = (rel: string) => readFileSync(path.join(RAIZ, rel), 'utf-8')

function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('el efecto sobre el hecho', () => {
  test('cuenta como homicidio doloso', () => {
    assert.deepEqual(
      efectoDeClasificacion('violencia_policial'),
      { snicCodigo: 1, esFemicidio: false }
    )
  })

  test('esHomicidioSegunClasificacion devuelve true', () => {
    assert.equal(esHomicidioSegunClasificacion('violencia_policial'), true)
  })

  test('no marca femicidio', () => {
    // Un caso puede ser las dos cosas, pero eso lo decide quien revisa
    // eligiendo "Femicidio"; esta clasificación por sí sola no lo implica.
    assert.equal(efectoDeClasificacion('violencia_policial').esFemicidio, false)
  })
})

describe('el valor es aceptado por la base', () => {
  test('está en el CHECK de revisiones_pipeline', () => {
    // Verificado también contra el constraint desplegado en Neon: la consulta a
    // pg_constraint confirmó que 'violencia_policial' está entre los 6 valores
    // permitidos, así que no hace falta migración.
    const sql = leer('scripts/sql/create-revisiones-pipeline.sql')
    assert.match(sql, /'violencia_policial'/)
  })
})

describe('la UI la ofrece', () => {
  const page = leer('src/app/admin/revisiones/page.tsx')

  test('hay un botón en CLASIFICACIONES', () => {
    assert.match(page, /valor:\s*'violencia_policial'/)
  })

  test('tiene etiqueta en ETIQUETA_CLASIFICACION', () => {
    // Sin esto, las tarjetas de "Revisados recientes" mostrarían el valor crudo.
    assert.match(page, /violencia_policial:\s*'Violencia policial'/)
  })

  test('el grid aguanta 6 botones sin cambios', () => {
    // grid-cols-2 sm:grid-cols-3 con 6 entradas queda parejo: 3×2 en mobile,
    // 2×3 en desktop. Con 5 quedaba uno huérfano.
    assert.match(page, /grid-cols-2 sm:grid-cols-3/)
    const botones = (page.match(/\{ valor: '/g) ?? []).length
    assert.equal(botones % 3, 0, `${botones} botones: el grid de 3 columnas queda desparejo`)
  })
})

describe('las heurísticas negativas hardcodeadas quedaron fuera', () => {
  const codigo = sinComentarios(leer('src/app/admin/revisiones/page.tsx'))

  test('la UI usa el helper compartido, no una comparación literal', () => {
    // `!== 'no_es_homicidio'` daba "es homicidio" para cualquier valor nuevo,
    // aunque el backend lo interpretara al revés. Con violencia_policial el
    // resultado coincidía por casualidad; con la próxima clasificación no.
    assert.ok(
      !/!==\s*'no_es_homicidio'/.test(codigo),
      'volvió una heurística negativa hardcodeada: divergirá del backend'
    )
    assert.match(codigo, /esHomicidioSegunClasificacion\(/)
  })

  test('el update optimista también deriva del helper', () => {
    assert.match(
      codigo,
      /confianza_hecho:\s*esHomicidioSegunClasificacion\(clasificacion\)/
    )
  })
})

describe('la documentación está al día', () => {
  const manual = leer('docs/manual-revisores.md')

  test('el manual dice seis opciones, no cinco', () => {
    assert.match(manual, /una de las seis opciones/)
    assert.ok(!/una de las cinco opciones/.test(manual))
  })

  test('la tabla explica cuándo usarla', () => {
    assert.match(manual, /\*\*Violencia policial\*\*/)
    assert.match(manual, /gatillo fácil/)
  })
})

describe('el aprendizaje few-shot la traduce bien', () => {
  test('produce un ejemplo de homicidio, no de caso descartado', async () => {
    // Si cayera al fallback, el ejemplo le enseñaría al modelo que un caso de
    // violencia policial NO es un hecho delictivo — exactamente lo contrario.
    const { construirEjemplosFewShot } = await import('../../src/lib/mapa/openrouter')
    const mensajes = construirEjemplosFewShot([
      { resumen: 'Un policía disparó y mató a un joven en una persecución.', clasificacion: 'violencia_policial' },
    ])
    const asistente = JSON.parse(mensajes[1].content)
    assert.equal(asistente.esHechoDelictivo, true)
    assert.equal(asistente.snic_codigo, 1)
    assert.equal(asistente.es_femicidio, false)
  })
})
