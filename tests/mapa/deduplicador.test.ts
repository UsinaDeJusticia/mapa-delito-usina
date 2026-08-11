import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mismoNombreVictima } from '../../src/lib/mapa/deduplicador'

// ════════════════════════════════════════════
// mismoNombreVictima
// ════════════════════════════════════════════
//
// El resto del deduplicador depende de Prisma (buscarHechosSimilares) y del
// cliente LLM (confirmarConIA), así que no se testea acá sin una base real.
// La coincidencia por nombre es la única pieza puramente determinista y sin
// dependencias, y es la que resuelve el caso más común de duplicado antes de
// llegar al modelo — vale la pena cubrirla a fondo.

describe('mismoNombreVictima', () => {
  test('reconoce el mismo nombre con distinta completitud', () => {
    assert.equal(mismoNombreVictima('Juan Pérez', 'Juan Carlos Pérez González'), true)
    assert.equal(mismoNombreVictima('Juan Carlos Pérez González', 'Juan Pérez'), true)
  })

  test('ignora acentos, mayúsculas y puntuación', () => {
    assert.equal(mismoNombreVictima('JOSÉ MARÍA GÓMEZ', 'jose maria gomez'), true)
    assert.equal(mismoNombreVictima('Ana Paz', 'ANA  PAZ.'), true)
  })

  test('ignora partículas', () => {
    assert.equal(mismoNombreVictima('Ana de la Cruz Díaz', 'Ana Cruz Diaz'), true)
  })

  test('distingue personas diferentes', () => {
    assert.equal(mismoNombreVictima('Juan Pérez', 'Juan Gómez'), false)
    assert.equal(mismoNombreVictima('María López', 'Marta López'), false)
  })

  test('un solo token es demasiado genérico para afirmar identidad', () => {
    assert.equal(mismoNombreVictima('Juan', 'Juan Pérez'), false)
    assert.equal(mismoNombreVictima('Juan', 'Juan'), false)
  })

  test('maneja null, undefined y cadenas vacías', () => {
    assert.equal(mismoNombreVictima(null, 'Juan Pérez'), false)
    assert.equal(mismoNombreVictima('Juan Pérez', undefined), false)
    assert.equal(mismoNombreVictima('', ''), false)
  })
})
