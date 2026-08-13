import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mismoNombreVictima, FALLBACK_DEDUP } from '../../src/lib/mapa/deduplicador'

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

// ════════════════════════════════════════════
// FALLBACK_DEDUP
// ════════════════════════════════════════════
//
// EL DEFECTO: cuando el proveedor de IA fallaba o devolvía algo inválido,
// deduplicar() caía a este resultado con confianza baja. El comentario decía
// "la confianza baja deja el caso marcado para revisión", pero nada lo hacía:
// requiereRevision en el hecho creado venía únicamente de la confianza de
// EXTRACCIÓN (datos.requiereRevision), nunca de la deduplicación. Con
// OpenCode Go como único proveedor (ver docs/llm/DECISIONS.md), una caída de
// una hora insertaba un duplicado por cada noticia procesada, sin ninguna
// marca visible en /admin/revisiones — para una organización que publica
// estadística de homicidios, inflar los números así es peor que demorar un
// dato.
//
// Encontrado revisando `claude/review-duckdb-architecture-zfJFO` antes de
// archivarla: esa rama había detectado el mismo problema en junio, con una
// solución más elaborada (política PIPELINE_DEDUP_FALLO configurable) que no
// llegó a mergearse. Esta es la versión mínima: la marca siempre queda
// puesta, sin agregar una variable de entorno nueva.

describe('FALLBACK_DEDUP', () => {
  test('pide revisión — es la corrección de este fix', () => {
    assert.equal(
      FALLBACK_DEDUP.requiereRevision,
      true,
      'sin esto, una falla del proveedor de IA inserta duplicados sin ninguna marca'
    )
  })

  test('sigue asumiendo hecho nuevo, con confianza baja', () => {
    // Preferir un duplicado (que un humano puede fusionar) a vincular la
    // cobertura al hecho equivocado — ese comportamiento no cambia con este
    // fix, solo se le agrega la marca de revisión que faltaba.
    assert.equal(FALLBACK_DEDUP.esNuevo, true)
    assert.equal(FALLBACK_DEDUP.candidatoId, null)
    assert.ok(FALLBACK_DEDUP.confianza < 50, 'la confianza tiene que quedar baja')
  })
})
