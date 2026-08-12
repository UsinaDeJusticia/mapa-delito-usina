/**
 * Clasificación de femicidios.
 *
 * El defecto: tanto el prompt del LLM como el panel de revisión asignaban el
 * código SNIC 4 a "femicidio". Pero el código 4 del catálogo oficial que siembra
 * prisma/seed.ts es "Homicidios culposos por otros hechos" — negligencia médica,
 * accidentes laborales. Así que un femicidio quedaba guardado como muerte
 * accidental, indistinguible de una mala praxis, y el InfoWindow del mapa público
 * mostraba literalmente ese texto.
 *
 * La corrección: un femicidio es un homicidio doloso (código 1) y la condición se
 * marca aparte en hechos_delictivos.femicidio, la misma columna que usa la
 * ingesta oficial del SAT y que cuentan las vistas materializadas.
 *
 * Estos tests fijan el contrato entre las tres piezas que tenían que coincidir y
 * no coincidían: el catálogo sembrado, el vocabulario del prompt, y el mapeo del
 * panel de revisión.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { validarExtraccion } from '../../src/lib/pipeline/schemas-llm'

const RAIZ = process.cwd()
const HOY = new Date('2026-08-06T12:00:00Z')

function leer(rel: string): string {
  return readFileSync(path.join(RAIZ, rel), 'utf-8')
}

/** Catálogo oficial tal como lo siembra prisma/seed.ts. */
const CATALOGO_OFICIAL: Record<string, string> = {
  '1': 'Homicidios dolosos',
  '2': 'Homicidios dolosos en grado de tentativa',
  '3': 'Muertes en siniestros viales',
  '4': 'Homicidios culposos por otros hechos',
}

const EXTRACCION_BASE = {
  esHechoDelictivo: true,
  snic_codigo: 1,
  provincia: 'Santa Fe',
  localidad: 'Rosario',
  barrio_o_direccion: null,
  fecha_hecho: '2026-08-04',
  cantidad_victimas: 1,
  resumen_hecho: 'Una mujer fue asesinada por su expareja.',
  nombre_victima: 'N. N.',
  requiereRevision: false,
  confianzaExtraccion: 92,
}

describe('el catálogo sembrado no tiene un código para femicidio', () => {
  test('seed.ts no declara ningún tipo de delito llamado Femicidio', () => {
    const seed = leer('prisma/seed.ts')
    const tiposDelito = seed.slice(
      seed.indexOf('const tiposDelito'),
      seed.indexOf('const homicide') > 0 ? seed.indexOf('const homicide') : undefined
    )
    assert.ok(
      !/nombre:\s*'Femicidio'/.test(tiposDelito),
      'si existiera un TipoDelito Femicidio, el diseño sería otro'
    )
  })

  test('el código 4 es culposo, no femicidio', () => {
    const seed = leer('prisma/seed.ts')
    assert.match(
      seed,
      /codigoSnic:\s*'4',\s*nombre:\s*'Homicidios culposos por otros hechos'/,
      'el catálogo cambió: revisar el mapeo de clasificaciones'
    )
  })

  test('el código 1 es homicidio doloso, que es donde va un femicidio', () => {
    const seed = leer('prisma/seed.ts')
    assert.match(seed, /codigoSnic:\s*'1',\s*nombre:\s*'Homicidios dolosos'/)
  })
})

describe('el panel de revisión mapea femicidio al código correcto', () => {
  const route = leer('src/app/api/admin/revisiones/route.ts')

  test('femicidio va al código 1, no al 4', () => {
    const mapeo = route.match(/'femicidio':\s*(\d+|null)/)
    assert.ok(mapeo, 'debería existir la entrada femicidio en CLASIFICACION_SNIC')
    assert.equal(
      mapeo![1],
      '1',
      `femicidio quedó mapeado al código ${mapeo![1]}, que es "${CATALOGO_OFICIAL[mapeo![1]] ?? 'desconocido'}"`
    )
  })

  test('ninguna clasificación de homicidio usa el código 4', () => {
    // El 4 es culposo por otros hechos. Ninguna de las cinco clasificaciones del
    // panel corresponde a eso: todas son dolosas o "no es homicidio".
    const bloque = route.slice(
      route.indexOf('const CLASIFICACION_SNIC'),
      route.indexOf('CLASIFICACIONES_FEMICIDIO')
    )
    assert.ok(
      !/:\s*4,/.test(bloque),
      'alguna clasificación volvió a apuntar al código 4 (homicidios culposos)'
    )
  })

  test('el UPDATE persiste la marca de femicidio', () => {
    assert.match(
      route,
      /femicidio\s*=\s*\$\{esFemicidio\s*\?\s*'Si'\s*:\s*null\}/,
      'el UPDATE debe escribir la columna femicidio con el formato del SAT'
    )
  })

  test("usa 'Si' y no true, para coincidir con lo que escribe la ingesta SAT", () => {
    // Las vistas materializadas cuentan `femicidio = 'Si'`. Escribir true o
    // 'true' haría que los casos revisados a mano no se cuenten.
    const vistas = leer('scripts/sql/create-materialized-views.sql')
    assert.match(vistas, /femicidio\s*=\s*'Si'/, 'la vista cuenta con Si')
    assert.match(route, /'Si'/, 'el UPDATE debe usar el mismo literal')
  })
})

describe('el prompt del LLM ya no ofrece el código 4 para femicidio', () => {
  const openrouter = leer('src/lib/mapa/openrouter.ts')

  test('el prompt no asocia el código 4 con femicidio', () => {
    const prompt = openrouter.slice(
      openrouter.indexOf('const PROMPT_SISTEMA'),
      openrouter.indexOf('// ════', openrouter.indexOf('const PROMPT_SISTEMA'))
    )
    assert.ok(
      !/4\s*=\s*Femicidio/i.test(prompt),
      'el prompt volvió a ofrecer el código 4 como femicidio'
    )
  })

  test('el prompt instruye explícitamente a no usar el 4 para femicidio', () => {
    assert.match(
      openrouter,
      /NUNCA uses el código 4 para un femicidio/,
      'la instrucción negativa explícita evita que el modelo lo reintroduzca'
    )
  })

  test('el prompt pide el campo es_femicidio en la salida', () => {
    assert.match(openrouter, /"es_femicidio"/)
  })

  test('SNIC_DESCRIPCION coincide con el catálogo sembrado', () => {
    for (const [codigo, nombre] of Object.entries(CATALOGO_OFICIAL)) {
      assert.ok(
        openrouter.includes(`${codigo}: '${nombre}'`),
        `SNIC_DESCRIPCION debería mapear ${codigo} a "${nombre}"`
      )
    }
  })

  test('el prompt restringe el código 3 a siniestros viales', () => {
    // Antes decía "accidentes de tránsito fatales, negligencia médica,
    // accidentes laborales", mezclando el 3 con el 4 del catálogo.
    assert.match(openrouter, /3 = Muertes en siniestros viales/)
    assert.ok(
      !/3 = Homicidio culposo/.test(openrouter),
      'el código 3 volvió a incluir causas no viales'
    )
  })
})

describe('validarExtraccion maneja es_femicidio', () => {
  test('acepta true y lo normaliza a esFemicidio', () => {
    const r = validarExtraccion({ ...EXTRACCION_BASE, es_femicidio: true }, HOY)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.esFemicidio, true)
  })

  test('acepta false', () => {
    const r = validarExtraccion({ ...EXTRACCION_BASE, es_femicidio: false }, HOY)
    assert.equal(r.ok && r.valor.esFemicidio, false)
  })

  test('un campo ausente equivale a false, no marca femicidio por omisión', () => {
    const r = validarExtraccion(EXTRACCION_BASE, HOY)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.esFemicidio, false)
  })

  test('solo el boolean exacto cuenta: un string o un 1 no marcan femicidio', () => {
    // Marcar un caso como femicidio por una coerción de tipo sería un error con
    // consecuencias sobre cifras públicas.
    for (const valor of ['true', 'Si', 1, 'si', {}, []]) {
      const r = validarExtraccion({ ...EXTRACCION_BASE, es_femicidio: valor }, HOY)
      assert.equal(r.ok, true, 'un valor raro no debe invalidar toda la extracción')
      if (!r.ok) continue
      assert.equal(
        r.valor.esFemicidio,
        false,
        `${JSON.stringify(valor)} no debería marcar femicidio`
      )
    }
  })

  test('un femicidio se extrae con código 1 y la marca puesta', () => {
    const r = validarExtraccion(
      { ...EXTRACCION_BASE, snic_codigo: 1, es_femicidio: true },
      HOY
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.snicCodigo, 1, 'el código oficial sigue siendo doloso')
    assert.equal(r.valor.esFemicidio, true, 'y la condición queda marcada aparte')
  })
})

describe('el pipeline persiste la marca', () => {
  test('el create escribe femicidio con el formato del SAT', () => {
    const pipeline = leer('scripts/pipeline/scrapear-medios.ts')
    assert.match(
      pipeline,
      /femicidio:\s*datos\.esFemicidio\s*\?\s*'Si'\s*:\s*null/,
      'el pipeline debe guardar la marca al crear el hecho'
    )
  })
})
