import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validarLinksIdentificados,
  validarExtraccion,
  validarDeduplicacion,
  parsearJsonLLM,
  fechaRazonable,
  enteroEnRango,
  textoOpcional,
  LARGO_MAX,
} from '../../src/lib/pipeline/schemas-llm'

const HOY = new Date('2026-08-05T12:00:00Z')

// ════════════════════════════════════════════
// PRIMITIVAS
// ════════════════════════════════════════════

describe('fechaRazonable', () => {
  test('acepta fechas recientes', () => {
    for (const f of ['2026-08-04', '2026-01-01', '2025-12-31', '1990-01-01']) {
      const r = fechaRazonable(f, 'fecha', HOY)
      assert.equal(r.ok, true, `debería aceptar ${f}`)
    }
  })

  test('acepta null, undefined y cadena vacía', () => {
    for (const v of [null, undefined, '']) {
      const r = fechaRazonable(v, 'fecha', HOY)
      assert.equal(r.ok && r.valor, null)
    }
  })

  test('rechaza fechas futuras', () => {
    assert.equal(fechaRazonable('2026-12-01', 'fecha', HOY).ok, false)
    assert.equal(fechaRazonable('2090-01-01', 'fecha', HOY).ok, false)
  })

  test('tolera un día de margen por husos horarios', () => {
    assert.equal(fechaRazonable('2026-08-06', 'fecha', HOY).ok, true)
    assert.equal(fechaRazonable('2026-08-07', 'fecha', HOY).ok, false)
  })

  test('rechaza fechas anteriores a 1990', () => {
    assert.equal(fechaRazonable('1989-12-31', 'fecha', HOY).ok, false)
    assert.equal(fechaRazonable('1200-05-05', 'fecha', HOY).ok, false)
  })

  test('rechaza fechas inexistentes en el calendario', () => {
    for (const f of ['2026-02-31', '2026-13-01', '2026-00-10', '2025-02-29']) {
      assert.equal(fechaRazonable(f, 'fecha', HOY).ok, false, `debería rechazar ${f}`)
    }
  })

  test('rechaza formatos que no son YYYY-MM-DD', () => {
    for (const f of ['05/08/2026', '2026-8-5', 'ayer', '2026-08-04T00:00:00Z', '20260804']) {
      assert.equal(fechaRazonable(f, 'fecha', HOY).ok, false, `debería rechazar ${f}`)
    }
  })
})

describe('enteroEnRango', () => {
  test('acepta enteros dentro del rango', () => {
    assert.equal(enteroEnRango(50, 'x', 0, 100).ok, true)
    assert.equal(enteroEnRango(0, 'x', 0, 100).ok, true)
    assert.equal(enteroEnRango(100, 'x', 0, 100).ok, true)
  })

  test('rechaza fuera de rango, decimales y no números', () => {
    for (const v of [-1, 101, 1.5, NaN, Infinity, '50', null, undefined, {}]) {
      assert.equal(enteroEnRango(v, 'x', 0, 100).ok, false, `debería rechazar ${JSON.stringify(v)}`)
    }
  })
})

describe('textoOpcional', () => {
  test('recorta y acepta texto normal', () => {
    const r = textoOpcional('  Hola  ', 'campo', 100)
    assert.equal(r.ok && r.valor, 'Hola')
  })

  test('convierte vacío y solo-espacios en null', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = textoOpcional(v, 'campo', 100)
      assert.equal(r.ok && r.valor, null)
    }
  })

  test('rechaza texto que excede el largo máximo', () => {
    assert.equal(textoOpcional('x'.repeat(101), 'campo', 100).ok, false)
  })

  test('rechaza caracteres de control', () => {
    for (const v of ['a\x00b', 'a\x07b', 'a\x1Bb', 'a\x7Fb', 'a\x0Bb']) {
      assert.equal(
        textoOpcional(v, 'campo', 100).ok,
        false,
        `debería rechazar ${JSON.stringify(v)}`
      )
    }
  })

  test('acepta saltos de línea y tabs, que son legítimos en un resumen', () => {
    assert.equal(textoOpcional('linea1\nlinea2\tcol', 'campo', 100).ok, true)
  })

  test('rechaza tipos que no son string', () => {
    for (const v of [42, {}, [], true]) {
      assert.equal(textoOpcional(v, 'campo', 100).ok, false)
    }
  })
})

// ════════════════════════════════════════════
// 1. LINKS IDENTIFICADOS
// ════════════════════════════════════════════

describe('validarLinksIdentificados', () => {
  test('acepta una respuesta bien formada', () => {
    const { links, descartados } = validarLinksIdentificados([
      { ref: 'e1', titulo: 'Crimen en Rosario' },
      { ref: 'e7', titulo: 'Hallaron un cuerpo' },
    ])
    assert.equal(links.length, 2)
    assert.deepEqual(links[0], { ref: 'e1', titulo: 'Crimen en Rosario' })
    assert.equal(descartados.length, 0)
  })

  test('descarta refs con inyección y conserva los válidos', () => {
    const { links, descartados } = validarLinksIdentificados([
      { ref: 'e1', titulo: 'Nota buena' },
      { ref: 'e2; rm -rf /', titulo: 'Nota hostil' },
      { ref: '$(whoami)', titulo: 'Otra hostil' },
      { ref: 'e3', titulo: 'Otra buena' },
    ])
    assert.equal(links.length, 2, 'debe conservar los dos válidos')
    assert.deepEqual(links.map(l => l.ref), ['e1', 'e3'])
    assert.equal(descartados.length, 2)
  })

  test('los descartes no incluyen el payload recibido', () => {
    const { descartados } = validarLinksIdentificados([
      { ref: 'e1; curl http://evil.test', titulo: 'x' },
    ])
    assert.equal(descartados.length, 1)
    assert.ok(!descartados[0].includes('evil.test'), 'no debe filtrar el payload')
  })

  test('rechaza cuando la respuesta no es un array', () => {
    for (const v of [{}, 'texto', 42, null, undefined]) {
      const { links, descartados } = validarLinksIdentificados(v)
      assert.equal(links.length, 0)
      assert.equal(descartados.length, 1)
    }
  })

  test('descarta duplicados de ref', () => {
    const { links, descartados } = validarLinksIdentificados([
      { ref: 'e1', titulo: 'Uno' },
      { ref: 'e1', titulo: 'Uno otra vez' },
    ])
    assert.equal(links.length, 1)
    assert.match(descartados[0], /duplicado/)
  })

  test('descarta entradas sin título', () => {
    const { links } = validarLinksIdentificados([
      { ref: 'e1', titulo: '' },
      { ref: 'e2' },
      { ref: 'e3', titulo: '   ' },
    ])
    assert.equal(links.length, 0)
  })

  test('topea la cantidad de links y lo reporta', () => {
    const muchos = Array.from({ length: 25 }, (_, i) => ({ ref: `e${i}`, titulo: `Nota ${i}` }))
    const { links, descartados } = validarLinksIdentificados(muchos)
    assert.equal(links.length, 10)
    assert.ok(descartados.some(d => /máximo/.test(d)), 'debe avisar del tope')
  })

  test('descarta entradas que no son objetos', () => {
    const { links } = validarLinksIdentificados(['e1', 42, null, ['e2']])
    assert.equal(links.length, 0)
  })
})

// ════════════════════════════════════════════
// 2. EXTRACCIÓN
// ════════════════════════════════════════════

const EXTRACCION_OK = {
  esHechoDelictivo: true,
  snic_codigo: 1,
  provincia: 'Santa Fe',
  localidad: 'Rosario',
  barrio_o_direccion: 'Zona sur',
  fecha_hecho: '2026-08-04',
  cantidad_victimas: 1,
  resumen_hecho: 'Un hombre fue asesinado en la zona sur de Rosario.',
  nombre_victima: 'N. N.',
  requiereRevision: false,
  confianzaExtraccion: 92,
}

describe('validarExtraccion', () => {
  test('acepta una respuesta completa y normaliza los campos', () => {
    const r = validarExtraccion(EXTRACCION_OK, HOY)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.esHechoDelictivo, true)
    assert.equal(r.valor.snicCodigo, 1)
    assert.equal(r.valor.provincia, 'Santa Fe')
    assert.equal(r.valor.cantidadVictimas, 1)
    assert.equal(r.valor.confianzaExtraccion, 92)
  })

  test('acepta nulls en los campos opcionales', () => {
    const r = validarExtraccion(
      {
        ...EXTRACCION_OK,
        provincia: null,
        localidad: null,
        barrio_o_direccion: null,
        fecha_hecho: null,
        cantidad_victimas: null,
        nombre_victima: null,
        snic_codigo: null,
      },
      HOY
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.provincia, null)
    assert.equal(r.valor.snicCodigo, null)
  })

  test('rechaza esHechoDelictivo que no es boolean', () => {
    for (const v of ['true', 1, null, undefined]) {
      const r = validarExtraccion({ ...EXTRACCION_OK, esHechoDelictivo: v }, HOY)
      assert.equal(r.ok, false, `debería rechazar ${JSON.stringify(v)}`)
    }
  })

  test('rechaza confianza fuera de 0-100', () => {
    for (const v of [-5, 101, 1000, 'alta', null, 92.5]) {
      const r = validarExtraccion({ ...EXTRACCION_OK, confianzaExtraccion: v }, HOY)
      assert.equal(r.ok, false, `debería rechazar confianza ${JSON.stringify(v)}`)
    }
  })

  test('rechaza códigos SNIC fuera del enum', () => {
    for (const v of [5, 99, -1, '1', 1.5] as unknown[]) {
      const r = validarExtraccion({ ...EXTRACCION_OK, snic_codigo: v }, HOY)
      assert.equal(r.ok, false, `debería rechazar snic_codigo ${JSON.stringify(v)}`)
    }
  })

  test('acepta todos los códigos SNIC del enum', () => {
    for (const v of [0, 1, 2, 3, 4]) {
      const r = validarExtraccion({ ...EXTRACCION_OK, snic_codigo: v }, HOY)
      assert.equal(r.ok, true, `debería aceptar snic_codigo ${v}`)
    }
  })

  test('rechaza cantidad de víctimas cero, negativa o absurda', () => {
    for (const v of [0, -1, 101, 1.5, 'dos']) {
      const r = validarExtraccion({ ...EXTRACCION_OK, cantidad_victimas: v }, HOY)
      assert.equal(r.ok, false, `debería rechazar cantidad_victimas ${JSON.stringify(v)}`)
    }
  })

  test('rechaza fechas futuras o imposibles', () => {
    for (const v of ['2090-01-01', '2026-02-31', 'ayer']) {
      const r = validarExtraccion({ ...EXTRACCION_OK, fecha_hecho: v }, HOY)
      assert.equal(r.ok, false, `debería rechazar fecha ${v}`)
    }
  })

  test('rechaza texto que excede los límites de longitud', () => {
    const r = validarExtraccion(
      { ...EXTRACCION_OK, resumen_hecho: 'x'.repeat(LARGO_MAX.resumen + 1) },
      HOY
    )
    assert.equal(r.ok, false)
  })

  test('rechaza una respuesta que no es objeto', () => {
    for (const v of [null, 'texto', 42, [], undefined]) {
      assert.equal(validarExtraccion(v, HOY).ok, false)
    }
  })

  test('acumula todos los errores en lugar de cortar en el primero', () => {
    const r = validarExtraccion(
      { esHechoDelictivo: 'no', confianzaExtraccion: 500, snic_codigo: 77, cantidad_victimas: -3 },
      HOY
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.errores.length >= 4, `esperaba varios errores, hubo ${r.errores.length}`)
  })

  test('requiereRevision solo es true con el boolean exacto', () => {
    const a = validarExtraccion({ ...EXTRACCION_OK, requiereRevision: 'true' }, HOY)
    assert.equal(a.ok && a.valor.requiereRevision, false)
    const b = validarExtraccion({ ...EXTRACCION_OK, requiereRevision: true }, HOY)
    assert.equal(b.ok && b.valor.requiereRevision, true)
  })
})

// ════════════════════════════════════════════
// 3. DEDUPLICACIÓN
// ════════════════════════════════════════════

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']

describe('validarDeduplicacion', () => {
  test('acepta esNuevo true sin candidatoId', () => {
    const r = validarDeduplicacion(
      { esNuevo: true, candidatoId: null, confianza: 95, razon: 'sin similares' },
      IDS
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.esNuevo, true)
    assert.equal(r.valor.candidatoId, null)
  })

  test('acepta esNuevo false con un candidatoId del conjunto enviado', () => {
    const r = validarDeduplicacion(
      { esNuevo: false, candidatoId: IDS[1], confianza: 88, razon: 'misma víctima' },
      IDS
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.candidatoId, IDS[1])
  })

  // La regla crítica: sin esto, un ID alucinado vinculaba la cobertura a un
  // hecho arbitrario de la base.
  test('rechaza un candidatoId que NO pertenece al conjunto enviado', () => {
    const r = validarDeduplicacion(
      { esNuevo: false, candidatoId: '99999999-9999-4999-8999-999999999999', confianza: 90, razon: 'x' },
      IDS
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.errores.some(e => /no pertenece al conjunto/.test(e)))
  })

  test('el error no filtra el ID recibido', () => {
    const r = validarDeduplicacion(
      { esNuevo: false, candidatoId: 'id-inventado-por-el-modelo', confianza: 90, razon: 'x' },
      IDS
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(!r.errores.join(' ').includes('id-inventado-por-el-modelo'))
  })

  test('rechaza esNuevo false sin candidatoId', () => {
    for (const v of [null, undefined, '', '   ']) {
      const r = validarDeduplicacion({ esNuevo: false, candidatoId: v, confianza: 90, razon: 'x' }, IDS)
      assert.equal(r.ok, false, `debería rechazar candidatoId ${JSON.stringify(v)}`)
    }
  })

  test('rechaza la contradicción esNuevo true con candidatoId', () => {
    const r = validarDeduplicacion(
      { esNuevo: true, candidatoId: IDS[0], confianza: 90, razon: 'x' },
      IDS
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.errores.some(e => /no debe venir cuando esNuevo es true/.test(e)))
  })

  test('rechaza esNuevo que no es boolean', () => {
    for (const v of ['false', 0, null, undefined]) {
      assert.equal(validarDeduplicacion({ esNuevo: v, confianza: 90, razon: 'x' }, IDS).ok, false)
    }
  })

  test('rechaza confianza fuera de rango', () => {
    for (const v of [-1, 101, 'alta', null]) {
      assert.equal(
        validarDeduplicacion({ esNuevo: true, confianza: v, razon: 'x' }, IDS).ok,
        false
      )
    }
  })

  test('rechaza razón que excede el límite', () => {
    const r = validarDeduplicacion(
      { esNuevo: true, confianza: 90, razon: 'x'.repeat(LARGO_MAX.razon + 1) },
      IDS
    )
    assert.equal(r.ok, false)
  })

  test('con conjunto de candidatos vacío, cualquier candidatoId se rechaza', () => {
    const r = validarDeduplicacion({ esNuevo: false, candidatoId: IDS[0], confianza: 90, razon: 'x' }, [])
    assert.equal(r.ok, false)
  })

  test('completa la razón cuando viene ausente', () => {
    const r = validarDeduplicacion({ esNuevo: true, confianza: 90, razon: null }, IDS)
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.valor.razon, 'sin razón provista')
  })
})

// ════════════════════════════════════════════
// PARSEO
// ════════════════════════════════════════════

describe('parsearJsonLLM', () => {
  test('parsea JSON limpio', () => {
    const r = parsearJsonLLM('{"a":1}')
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.valor, { a: 1 })
  })

  test('tolera el fence de markdown', () => {
    for (const c of ['```json\n{"a":1}\n```', '```\n{"a":1}\n```', '  ```json\n{"a":1}```  ']) {
      const r = parsearJsonLLM(c)
      assert.equal(r.ok, true, `debería parsear ${JSON.stringify(c)}`)
    }
  })

  test('rechaza respuesta vacía', () => {
    for (const c of ['', '   ', '```json\n```']) {
      assert.equal(parsearJsonLLM(c).ok, false)
    }
  })

  test('rechaza JSON inválido con mensaje acotado', () => {
    const r = parsearJsonLLM('{no es json}')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.errores[0].length < 200)
  })

  test('rechaza respuestas absurdamente grandes', () => {
    const r = parsearJsonLLM('"' + 'x'.repeat(250_000) + '"')
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.errores[0], /200 KB/)
  })
})
