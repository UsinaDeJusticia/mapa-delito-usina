/**
 * Invariantes básicas de la lista MEDIOS (scripts/pipeline/scrapear-medios.ts).
 *
 * No corre el pipeline ni hace fetch a nada — es un test de texto sobre el
 * archivo fuente, en la misma línea que otros tests de este repo que
 * verifican configuración estática sin levantar servicios externos. Sirve
 * para que un `id` duplicado o una URL rota no pasen desapercibidos al
 * agregar medios nuevos.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const FUENTE = readFileSync(path.join(RAIZ, 'scripts/pipeline/scrapear-medios.ts'), 'utf-8')

/** Extrae los objetos de la lista MEDIOS línea por línea (una entrada por línea, formato consistente en todo el archivo). */
function entradasMedios(): Array<{ id: string; url: string | null; activo: boolean | null }> {
  const inicio = FUENTE.indexOf('const MEDIOS: MedioConfig[] = [')
  const fin = FUENTE.indexOf('\n]', inicio)
  const bloque = FUENTE.slice(inicio, fin)

  const entradas: Array<{ id: string; url: string | null; activo: boolean | null }> = []
  for (const linea of bloque.split('\n')) {
    const idMatch = linea.match(/id:\s*'([^']+)'/)
    if (!idMatch) continue
    // Toma la primera URL que aparezca en la línea, sea `url`, `urlBase` o `urlPoliciales`.
    const urlMatch = linea.match(/url(?:Base|Policiales)?:\s*'([^']+)'/)
    const activoMatch = linea.match(/activo:\s*(true|false)/)
    entradas.push({
      id: idMatch[1],
      url: urlMatch ? urlMatch[1] : null,
      activo: activoMatch ? activoMatch[1] === 'true' : null,
    })
  }
  return entradas
}

describe('la lista MEDIOS no tiene entradas rotas', () => {
  const entradas = entradasMedios()

  test('hay entradas (si esto da 0, el parser de arriba se desincronizó del formato real)', () => {
    assert.ok(entradas.length > 50, `esperaba más de 50 medios, encontré ${entradas.length}`)
  })

  test('ningún id se repite', () => {
    const vistos = new Set<string>()
    const repetidos: string[] = []
    for (const e of entradas) {
      if (vistos.has(e.id)) repetidos.push(e.id)
      vistos.add(e.id)
    }
    assert.deepEqual(repetidos, [], `ids duplicados en MEDIOS: ${repetidos.join(', ')}`)
  })

  test('toda entrada con URL usa http(s), nunca un dominio sin esquema', () => {
    for (const e of entradas) {
      if (e.url === null) continue
      assert.match(e.url, /^https?:\/\//, `${e.id}: URL sin esquema (${e.url})`)
    }
  })
})

describe('los medios de Buenos Aires agregados en esta ronda quedan sin activar hasta verificarlos a mano', () => {
  // No se pudo hacer fetch real a estos sitios (egress bloqueado en este
  // entorno) — activo:false hasta que alguien del equipo los abra una vez.
  const idsNuevos = [
    'mdp0223', 'elmarplatense', 'lanueva', 'ecosdiarios',
    'elpopularolav', '0221laplata', 'elcomercioonline', 'vivieloeste', 'minutouno',
  ]
  const entradas = entradasMedios()

  test('todos los ids nuevos existen en la lista', () => {
    const idsPresentes = new Set(entradas.map(e => e.id))
    for (const id of idsNuevos) {
      assert.ok(idsPresentes.has(id), `falta el medio nuevo "${id}" en MEDIOS`)
    }
  })

  test('ninguno quedó activo:true sin verificación manual', () => {
    for (const id of idsNuevos) {
      const entrada = entradas.find(e => e.id === id)
      assert.equal(entrada?.activo, false, `${id} quedó activo antes de la verificación manual`)
    }
  })
})
