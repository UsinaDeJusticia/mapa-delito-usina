/**
 * Cuatro defectos de correctitud alrededor de la revisión humana.
 *
 * El más importante es el primero, porque rompe justamente la garantía que se
 * quiso dar: que reclasificar un caso no rompa nada y se pueda corregir libremente.
 *
 * 6.a EL FILTRO DE PINES MIRABA CUALQUIER REVISIÓN, NO LA ÚLTIMA
 * `/api/mapa/hechos-medios` excluía del mapa los hechos con un
 * `NOT EXISTS (… clasificacion_humana = 'no_es_homicidio')`. Pero el POST de
 * /api/admin/revisiones SIEMPRE inserta una fila nueva — las correcciones son
 * filas, no updates. Así que un hecho marcado 'no_es_homicidio' y **después
 * corregido** a 'femicidio' conservaba la fila vieja y quedaba excluido del
 * mapa PARA SIEMPRE.
 *
 * Verificado contra Postgres real: con el filtro viejo, un caso corregido de
 * vuelta a femicidio no aparecía; con el nuevo, sí.
 *
 * 6.b QUINTO CAMINO CONTAMINADO DEL MODO SAT
 * El hallazgo #10 arregló cuatro caminos y se pasó `/api/mapa/sat-opciones`,
 * cuyas cinco consultas filtraban solo por `es_agregado = false`. Los conteos
 * de los chips —incluido el de femicidios— sumaban casos del pipeline como si
 * fueran dato oficial.
 *
 * 6.c EL POST NO ERA TRANSACCIONAL
 * INSERT en revisiones_pipeline y UPDATE de hechos_delictivos iban sueltos. Si
 * el segundo fallaba, quedaba una revisión registrada sin efecto — y como el
 * resto del sistema deriva el estado de la última revisión, el caso contaba
 * como revisado sin haber cambiado nada.
 *
 * 6.d `es_correccion` SE MANDABA Y SE IGNORABA
 * El front lo enviaba y el backend lo declaraba en el tipo del body sin leerlo
 * nunca. Promesa falsa en la API.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const leer = (rel: string) => readFileSync(path.join(RAIZ, rel), 'utf-8')

/** Quita comentarios SQL y de línea, para no dar por buena una regla comentada. */
function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

// ════════════════════════════════════════════
// 6.a — el filtro de pines usa la última revisión
// ════════════════════════════════════════════

describe('los pines del mapa se filtran por la ÚLTIMA revisión', () => {
  const src = leer('src/app/api/mapa/hechos-medios/route.ts')
  const codigo = sinComentarios(src)

  test('usa DISTINCT ON para quedarse con la revisión más reciente', () => {
    assert.match(
      codigo,
      /DISTINCT ON\s*\(\s*rp\.hecho_id\s*\)/,
      'sin esto, una corrección posterior no reemplaza la clasificación vieja'
    )
  })

  test('ordena por revisado_at DESC, que es lo que hace correcto al DISTINCT ON', () => {
    assert.match(codigo, /ORDER BY\s+rp\.hecho_id,\s*rp\.revisado_at DESC/)
  })

  test('ya no hay un NOT EXISTS ingenuo contra cualquier revisión', () => {
    // La forma vieja: NOT EXISTS (SELECT 1 FROM revisiones_pipeline rp
    // WHERE rp.hecho_id = hd.id AND rp.clasificacion_humana = 'no_es_homicidio')
    // sin subconsulta de "última". Si vuelve, los casos corregidos se pierden.
    const ingenuo =
      /NOT EXISTS\s*\(\s*SELECT 1\s+FROM revisiones_pipeline rp\s+WHERE rp\.hecho_id = hd\.id\s+AND rp\.clasificacion_humana/
    assert.ok(
      !ingenuo.test(codigo),
      'volvió el filtro que excluye del mapa para siempre a los casos corregidos'
    )
  })
})

// ════════════════════════════════════════════
// Código SNIC 0 fuera del mapa público
// ════════════════════════════════════════════

describe('el código SNIC 0 se guarda pero no se muestra', () => {
  test('los pines excluyen codigo_snic = 0', () => {
    // Decisión de producto: "muerte violenta en investigación" entra a la cola
    // de revisión, pero no al mapa público hasta que una persona confirme que
    // es un homicidio. Al confirmarlo, el POST le cambia el tipo_delito_id al
    // código 1 y el pin aparece solo — no hace falta otra condición.
    const codigo = sinComentarios(leer('src/app/api/mapa/hechos-medios/route.ts'))
    assert.match(codigo, /codigo_snic.*<>\s*'0'/)
  })
})

// ════════════════════════════════════════════
// 6.b — sat-opciones, el quinto camino
// ════════════════════════════════════════════

describe('sat-opciones solo cuenta fuentes oficiales', () => {
  const src = leer('src/app/api/mapa/sat-opciones/route.ts')
  const codigo = sinComentarios(src)

  test('las cinco consultas filtran por f.tipo = OFICIAL', () => {
    const filtros = codigo.split(/f\.tipo\s*=\s*'OFICIAL'/).length - 1
    assert.equal(filtros, 5, `esperaba 5 filtros, encontré ${filtros}`)
  })

  test('cada consulta hace el JOIN que ese filtro necesita', () => {
    const joins = codigo.split(/JOIN fuentes f ON hd\.fuente_id = f\.id/).length - 1
    assert.equal(joins, 5, `esperaba 5 JOIN a fuentes, encontré ${joins}`)
  })

  test('ninguna consulta quedó con es_agregado = false a secas', () => {
    const agregado = codigo.split(/es_agregado\s*=\s*false/).length - 1
    const oficial = codigo.split(/f\.tipo\s*=\s*'OFICIAL'/).length - 1
    assert.ok(
      oficial >= agregado,
      `${agregado} usos de es_agregado = false pero solo ${oficial} filtros de fuente: ` +
        'los dos son necesarios y distintos'
    )
  })
})

describe('guarda genérica: ninguna ruta del mapa cuenta microdatos sin filtrar la fuente', () => {
  // La guarda de tests/sql/fuente-oficial.test.ts solo audita tres archivos
  // hardcodeados, y por eso no detectó sat-opciones. Esta recorre el directorio.
  const DIR = path.join(RAIZ, 'src/app/api/mapa')

  /**
   * Excepción deliberada: hechos-medios NO debe filtrar por fuente oficial.
   *
   * Es el endpoint que sirve los pines del pipeline, y esos casos son
   * PERIODISTICA a propósito — mostrarlos como pines individuales, separados de
   * las cifras oficiales, es exactamente el diseño que resolvió el hallazgo #10.
   * Filtrarlos por OFICIAL los borraría del mapa.
   *
   * La distinción no es "microdatos sí o no": es si la ruta presenta el dato
   * como estadística oficial (modo SAT) o como caso del pipeline con su propia
   * leyenda PRELIMINAR.
   */
  const EXCEPCIONES = new Set(['src/app/api/mapa/hechos-medios/route.ts'])

  function rutas(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) rutas(full, acc)
      else if (e.name === 'route.ts') acc.push(full)
    }
    return acc
  }

  for (const ruta of rutas(DIR)) {
    const rel = path.relative(RAIZ, ruta)
    const codigo = sinComentarios(readFileSync(ruta, 'utf-8'))
    const agregado = codigo.split(/es_agregado\s*=\s*false/).length - 1
    if (agregado === 0) continue

    if (EXCEPCIONES.has(rel)) {
      // La excepción no es un permiso en blanco: se verifica que la ruta siga
      // siendo la del pipeline. Si dejara de servir casos PRELIMINARES, la
      // justificación caduca y hay que volver a mirarla.
      test(`${rel} está exceptuada, y sigue siendo la ruta del pipeline`, () => {
        assert.match(
          codigo,
          /PRELIMINAR/,
          'la excepción se justifica porque sirve los pines del pipeline; si eso cambió, revisarla'
        )
      })
      continue
    }

    test(`${rel} acompaña es_agregado = false con un filtro de fuente`, () => {
      const oficial = codigo.split(/f\.tipo\s*=\s*'OFICIAL'/).length - 1
      assert.ok(
        oficial >= agregado,
        `${rel}: ${agregado} usos de es_agregado = false y solo ${oficial} filtros de ` +
          'fuente. es_agregado separa el agregado anual del SNIC de los microdatos, ' +
          'pero NO distingue el dato oficial del periodístico.'
      )
    })
  }
})

// ════════════════════════════════════════════
// 6.c y 6.d — el POST
// ════════════════════════════════════════════

describe('el POST de revisiones es transaccional', () => {
  const src = leer('src/app/api/admin/revisiones/route.ts')
  const codigo = sinComentarios(src)

  test('envuelve las escrituras en $transaction', () => {
    assert.match(codigo, /prisma\.\$transaction/)
  })

  test('las escrituras usan el cliente de la transacción, no el global', () => {
    // Un `prisma.$executeRaw` dentro del bloque correría fuera de la
    // transacción y anularía la garantía.
    //
    // El slice se acota al SIGUIENTE export, no al final del archivo: cuando se
    // agregó el PATCH después del POST, la versión sin tope se comía esa función
    // y marcaba su `prisma.$executeRaw` —que es correcto, porque el PATCH hace un
    // solo UPDATE y no necesita transacción— como si fuera una regresión del POST.
    const desde = codigo.indexOf('export async function POST')
    const siguiente = codigo.indexOf('export async function', desde + 1)
    const post = codigo.slice(desde, siguiente === -1 ? undefined : siguiente)
    assert.ok(
      !/prisma\.\$executeRaw/.test(post),
      'hay un executeRaw sobre el cliente global dentro del POST: queda fuera de la transacción'
    )
    assert.match(post, /tx\.\$executeRaw/)
  })
})

describe('es_correccion ya no es una promesa falsa', () => {
  test('el backend no lo declara en el tipo del body', () => {
    const codigo = sinComentarios(leer('src/app/api/admin/revisiones/route.ts'))
    assert.ok(
      !/es_correccion\?:\s*boolean/.test(codigo),
      'volvió al tipo del body un campo que nadie lee'
    )
  })

  test('el front no lo manda', () => {
    const codigo = sinComentarios(leer('src/app/admin/revisiones/page.tsx'))
    assert.ok(
      !/es_correccion:\s*esCorreccion/.test(codigo),
      'el front volvió a mandar un campo que el backend ignora'
    )
  })
})
