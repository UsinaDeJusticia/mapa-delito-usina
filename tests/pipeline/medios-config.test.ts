/**
 * Invariantes de la lista MEDIOS.
 *
 * Antes este test parseaba el texto de scrapear-medios.ts con regex, porque ese
 * archivo ejecuta el pipeline al importarse y no se podía leer la lista de otra
 * forma. Al extraer MEDIOS a ./medios-config —que el health-check también
 * necesita— pasó a poder importarse de verdad: con tipos, sin regex, y sin que
 * un cambio de formato del archivo rompa el test por el motivo equivocado.
 *
 * RAMA `estable-premio`: esta rama reduce deliberadamente los 66 medios activos
 * de producción a 13, uno fuerte por región geográfica, para la presentación al
 * premio. No es una regresión de cobertura — es una decisión explícita: con 66
 * medios la corrida diaria pasó a usar GitHub Actions como si fuera un servidor
 * (~80 min/día contra sitios de terceros), lo cual viola sus políticas de uso.
 * La migración a un host propio con descubrimiento por feeds sigue en curso en
 * `claude/gifted-rubin-ad1Tg`; esta rama prioriza estabilidad y bajo riesgo
 * operativo para la demo, no escala. Los tests de abajo reflejan ESTE recorte
 * a propósito, no el de producción — no restaurarlos "por las dudas".
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { MEDIOS } from '../../scripts/pipeline/medios-config'

/** La URL que el pipeline visita: urlPoliciales gana, url es el legado. */
function urlDe(m: (typeof MEDIOS)[number]): string {
  return m.urlPoliciales || m.url || ''
}

describe('la lista MEDIOS no tiene entradas rotas', () => {
  test('hay medios cargados', () => {
    assert.ok(MEDIOS.length > 50, `esperaba más de 50 medios, encontré ${MEDIOS.length}`)
  })

  test('ningún id se repite', () => {
    const vistos = new Set<string>()
    const repetidos: string[] = []
    for (const m of MEDIOS) {
      if (vistos.has(m.id)) repetidos.push(m.id)
      vistos.add(m.id)
    }
    assert.deepEqual(repetidos, [], `ids duplicados: ${repetidos.join(', ')}`)
  })

  test('todos tienen una URL efectiva', () => {
    // Un medio sin url ni urlPoliciales se saltea en silencio en la corrida.
    const sinUrl = MEDIOS.filter(m => urlDe(m) === '')
    assert.deepEqual(sinUrl.map(m => m.id), [])
  })

  test('toda URL usa http o https', () => {
    for (const m of MEDIOS) {
      assert.match(urlDe(m), /^https?:\/\//, `${m.id}: URL sin esquema (${urlDe(m)})`)
    }
  })

  test('ningún id tiene espacios ni mayúsculas', () => {
    // Los ids se usan en --medio=<id> desde la línea de comandos.
    for (const m of MEDIOS) {
      assert.match(m.id, /^[a-z0-9]+$/, `${m.id}: el id debería ser alfanumérico minúscula`)
    }
  })

  test('todos tienen nombre legible', () => {
    for (const m of MEDIOS) {
      assert.ok(m.nombre && m.nombre.trim().length > 0, `${m.id} sin nombre`)
    }
  })
})

describe('los 7 candidatos de Buenos Aires del health-check existen igual, aunque acá estén desactivados', () => {
  // En producción (master) el health-check activó estos 7. En esta rama piloto
  // se desactivaron a propósito junto con el resto de Buenos Aires: la
  // cobertura geográfica de 13 medios no puede darle 8 entradas a una sola
  // provincia. Solo se verifica que sigan existiendo en la lista (no se
  // perdieron por accidente al recortar), no que estén activos.
  const CANDIDATOS_BA = [
    'mdp0223', 'elmarplatense', 'lanueva', '0221laplata',
    'elcomercioonline', 'vivieloeste', 'minutouno',
    'elpopularolav', 'ecosdiarios',
  ]

  test('todos existen en la lista', () => {
    const ids = new Set(MEDIOS.map(m => m.id))
    for (const id of CANDIDATOS_BA) {
      assert.ok(ids.has(id), `falta el medio "${id}"`)
    }
  })
})

describe('la cobertura piloto es exactamente la elegida para la presentación', () => {
  // 13 medios, uno fuerte por región, cruzados contra la corrida de producción
  // real del 22/8 antes de elegirlos (ver el plan de la rama estable-premio).
  // Si esta lista cambia, tiene que ser una decisión explícita, no un efecto
  // secundario de tocar medios-config.ts por otra razón.
  const PILOTO = [
    'infobae', 'eldia', 'lavoz', 'rosario3', 'losandes', 'eltribuno',
    'lagaceta', 'norte', 'ellitoralcorrientes', 'unoentrerios',
    'lmneuquen', 'rionegro', 'diariodecuyo',
  ]

  test('son exactamente estos 13, ni uno más ni uno menos', () => {
    const activos = MEDIOS.filter(m => m.activo !== false).map(m => m.id).sort()
    assert.deepEqual(activos, [...PILOTO].sort())
  })
})

describe('los medios con fallo inequívoco están desactivados', () => {
  // DNS que no resuelve y TLS inválido: no hay WAF de por medio, así que el
  // veredicto es concluyente. Cada uno gastaba tiempo de la corrida diaria.
  const MUERTOS = {
    jornada: 'dominio no resuelve',
    lamanana: 'dominio no resuelve',
    cadenaargentina: 'certificado TLS inválido',
  }

  for (const [id, motivo] of Object.entries(MUERTOS)) {
    test(`${id} está desactivado (${motivo})`, () => {
      assert.equal(MEDIOS.find(m => m.id === id)?.activo, false)
    })
  }
})

describe('cobertura por provincia — piloto de estable-premio', () => {
  // En producción (master) Buenos Aires tiene ≥12 medios activos porque es la
  // provincia con más homicidios. Acá, con solo 13 medios totales, la meta
  // explícita es UN medio fuerte por región (ver el plan de estable-premio) —
  // darle 12 a Buenos Aires dejaría a la mitad del país sin ningún pin en la
  // demo. Formosa, CABA propia, Misiones, Jujuy, etc. quedan fuera del piloto
  // a propósito: es una cobertura reducida, no un hueco accidental.
  test('Buenos Aires tiene exactamente 1 medio activo en el piloto', () => {
    const ba = MEDIOS.filter(m => m.provincia === 'Buenos Aires' && m.activo !== false)
    assert.deepEqual(ba.map(m => m.id), ['eldia'])
  })

  test('cada provincia del piloto aporta como máximo 1 medio activo', () => {
    // Es la propiedad que define "cobertura geográfica, no volumen": si algún
    // día se activa un segundo medio de la misma provincia sin desactivar el
    // primero, este test avisa en vez de dejarlo pasar en silencio.
    const porProvincia = new Map<string, string[]>()
    for (const m of MEDIOS) {
      if (m.activo === false || !m.provincia) continue
      const lista = porProvincia.get(m.provincia) ?? []
      lista.push(m.id)
      porProvincia.set(m.provincia, lista)
    }
    const conMasDeUno = [...porProvincia.entries()].filter(([, ids]) => ids.length > 1)
    assert.deepEqual(
      conMasDeUno, [],
      `provincias con más de 1 medio activo: ${conMasDeUno.map(([p, ids]) => `${p}: ${ids.join(', ')}`).join(' | ')}`
    )
  })
})

describe('los medios con paywall conocido están desactivados', () => {
  test('tienePaywall implica activo:false', () => {
    // Un medio con muro de pago consume tiempo de la corrida y no deja extraer
    // el cuerpo de la nota.
    const contradictorios = MEDIOS.filter(m => m.tienePaywall === true && m.activo !== false)
    assert.deepEqual(
      contradictorios.map(m => m.id),
      [],
      'hay medios marcados con paywall pero activos'
    )
  })
})
