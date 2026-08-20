/**
 * El código SNIC 0 deja de descartarse en silencio.
 *
 * EL DEFECTO — pérdida silenciosa de datos, no una inconsistencia cosmética
 * El prompt ofrecía `0 = Muerte violenta en investigación` para los cuerpos
 * hallados sin causa determinada, y el validador lo aceptaba
 * (CODIGOS_SNIC_VALIDOS incluye el 0). Pero:
 *
 *   1. prisma/seed.ts no tenía el código 0, así que no existía en tipos_delito.
 *   2. El lookup del pipeline era
 *        `datos.codigoSnicEstimado ? tipoPorCodigo.get(...) : null`
 *      y **0 es falsy en JS**: el lookup nunca corría, caía en
 *      `if (!tipoDelito)` y hacía `continue`.
 *
 * O sea que TODA noticia que el modelo clasificara como muerte de causa dudosa
 * se tiraba a la basura. Es justo el tipo de caso que más le importa a Usina,
 * porque varios se confirman después como femicidios.
 *
 * LA DECISIÓN
 * Se agrega el 0 como categoría real —queda visiblemente distinto de
 * "homicidio doloso", así que no infla el conteo de homicidios— con
 * requiereRevision, y **fuera del mapa público** hasta que una persona lo
 * confirme. Ese último filtro vive en /api/mapa/hechos-medios y lo cubre
 * tests/mapa/correctitud-revisiones.test.ts.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { validarExtraccion, CODIGOS_SNIC_VALIDOS } from '../../src/lib/pipeline/schemas-llm'

const RAIZ = process.cwd()
const leer = (rel: string) => readFileSync(path.join(RAIZ, rel), 'utf-8')

/** Quita líneas de comentario: los comentarios documentan el patrón viejo a propósito. */
function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

const NOMBRE_CODIGO_0 = 'Muerte violenta en investigación'

describe('el código 0 existe en las tres piezas que tenían que coincidir', () => {
  test('está en el catálogo que se siembra', () => {
    const seed = leer('prisma/seed.ts')
    assert.match(
      seed,
      new RegExp(`codigoSnic:\\s*'0',\\s*nombre:\\s*'${NOMBRE_CODIGO_0}'`),
      'sin esto el lookup de tipos_delito no encuentra nada y la noticia se descarta'
    )
  })

  test('el validador lo acepta', () => {
    assert.ok(CODIGOS_SNIC_VALIDOS.includes(0 as never))
  })

  test('el prompt lo ofrece con el mismo nombre que el catálogo', () => {
    // Si divergen, el auditor (npm run catalogo:auditar) lo marca. Fijarlo acá
    // además evita que se rompa entre corridas del auditor.
    const openrouter = leer('src/lib/mapa/openrouter.ts')
    assert.match(openrouter, new RegExp(`0 = ${NOMBRE_CODIGO_0}`))
  })

  test('SNIC_DESCRIPCION lo mapea igual', () => {
    const openrouter = leer('src/lib/mapa/openrouter.ts')
    assert.match(openrouter, new RegExp(`0:\\s*'${NOMBRE_CODIGO_0}'`))
  })

  test('el prompt pide requiereRevision cuando usa el 0', () => {
    // Un caso sin causa determinada tiene que pasar por una persona antes de
    // contarse como homicidio.
    const openrouter = leer('src/lib/mapa/openrouter.ts')
    assert.match(openrouter, /CÓDIGO 0 — SIEMPRE CON requiereRevision/)
  })
})

describe('el bug de truthiness no vuelve', () => {
  const codigo = sinComentarios(leer('scripts/pipeline/scrapear-medios.ts'))

  test('el lookup de tipo de delito compara contra null, no la verdad del valor', () => {
    assert.match(
      codigo,
      /datos\.codigoSnicEstimado != null\s*\n?\s*\?\s*tipoPorCodigo\.get/,
      'con `? :` el código 0 nunca se busca y la noticia se descarta'
    )
  })

  test('ningún uso de codigoSnicEstimado usa la verdad del valor', () => {
    // Guarda genérica: un `datos.codigoSnicEstimado ?` ternario (sin != null)
    // vuelve a romper el caso del 0.
    //
    // El (?!\?) excluye `??`, que es nullish coalescing y SÍ es correcto: trata
    // el 0 como valor y solo cae al default si es null o undefined. Sin esa
    // exclusión la guarda marcaba código bien escrito.
    const laxos = codigo.match(/datos\.codigoSnicEstimado\s*\?(?!\?)/g) ?? []
    assert.deepEqual(
      laxos,
      [],
      `hay ${laxos.length} comparación(es) laxa(s) de codigoSnicEstimado: 0 es falsy`
    )
  })
})

describe('validarExtraccion acepta el código 0 como caso legítimo', () => {
  const HOY = new Date('2026-08-20T12:00:00Z')
  const BASE = {
    esHechoDelictivo: true,
    provincia: 'Buenos Aires',
    localidad: 'La Matanza',
    barrio_o_direccion: null,
    fecha_hecho: '2026-08-18',
    cantidad_victimas: 1,
    resumen_hecho: 'Hallaron un cuerpo con signos de violencia, sin causa determinada.',
    nombre_victima: null,
    es_femicidio: false,
    confianzaExtraccion: 88,
  }

  test('snic_codigo 0 sobrevive la validación', () => {
    const r = validarExtraccion({ ...BASE, snic_codigo: 0, requiereRevision: true }, HOY)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.snicCodigo, 0)
  })

  test('el 0 se distingue de null: son cosas distintas', () => {
    // 0 = "hay un hecho, causa sin determinar". null = "no se pudo clasificar".
    // Si el validador los colapsara, se perdería la diferencia.
    const cero = validarExtraccion({ ...BASE, snic_codigo: 0 }, HOY)
    const nulo = validarExtraccion({ ...BASE, snic_codigo: null }, HOY)
    assert.equal(cero.ok && cero.valor.snicCodigo, 0)
    assert.equal(nulo.ok && nulo.valor.snicCodigo, null)
  })
})

describe('el catálogo generado queda al día', () => {
  test('docs/catalogo-snic.md incluye el código 0', () => {
    // Archivo generado por npm run catalogo:auditar. Si no lo tiene, el auditor
    // no se volvió a correr después de agregar el código.
    const doc = leer('docs/catalogo-snic.md')
    assert.match(doc, new RegExp(NOMBRE_CODIGO_0))
  })
})
