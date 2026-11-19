import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mismoNombreVictima,
  FALLBACK_DEDUP,
  CODIGOS_CANDIDATOS,
  ventanaCandidatos,
  combinarCandidatos,
  tokensParaBuscarNombre,
  construirPromptDeduplicacion,
  DIAS_CANDIDATOS_ATRAS,
} from '../../src/lib/mapa/deduplicador'

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

  test('una descripción no es un nombre: no fusiona homicidios distintos', () => {
    // Regresión: "un joven" contra "un joven de 17 años" daba true (dos
    // tokens contenidos) y la nota de un homicidio nuevo se vinculaba a otro
    // con confianza 97, sin IA ni revisión.
    assert.equal(mismoNombreVictima('un joven', 'un joven de 17 años'), false)
    assert.equal(mismoNombreVictima('No identificado', 'No identificado'), false)
    assert.equal(mismoNombreVictima('Una mujer', 'una mujer de 35 años'), false)
    assert.equal(mismoNombreVictima('menor de edad', 'Menor de edad'), false)
    assert.equal(mismoNombreVictima('Hombre de 40 años', 'hombre de 40 años'), false)
  })

  test('un nombre real rodeado de descripción sigue matcheando', () => {
    assert.equal(mismoNombreVictima('Juan Pérez, de 22 años', 'Juan Pérez'), true)
    assert.equal(mismoNombreVictima('el joven Lucas Gómez', 'Lucas Gómez'), true)
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

// ════════════════════════════════════════════
// Búsqueda de candidatos y prompt (caso Franco Jara, 19/11/2026)
// ════════════════════════════════════════════
//
// Dos notas de Infobae sobre la misma muerte en una comisaría de San Juan
// ("Imputaron por homicidio a los cinco policías… Franco Jara" e "Investigan a
// cinco policías por la muerte de un joven en una comisaría de San Juan")
// entraron como dos hechos nuevos.

describe('candidatos de deduplicación', () => {
  test('no se filtra por el código SNIC de la noticia: entran todos los del pipeline', () => {
    assert.deepEqual([...CODIGOS_CANDIDATOS], ['0', '1', '2', '3', '4'])
  })

  test('la ventana mira 60 días atrás: alcanza a las notas de seguimiento', () => {
    const ahora = new Date('2026-11-19T15:00:00Z')
    const { desde, hasta } = ventanaCandidatos('2026-11-19', ahora)
    const dias = (Date.parse('2026-11-19') - desde.getTime()) / 86_400_000
    assert.equal(dias, DIAS_CANDIDATOS_ATRAS)
    assert.ok(DIAS_CANDIDATOS_ATRAS >= 45)
    assert.ok(hasta.getTime() <= ahora.getTime() + 86_400_000, 'no busca en el futuro')
  })

  test('sin fecha o con fecha inválida usa hoy', () => {
    const ahora = new Date('2026-11-19T15:00:00Z')
    for (const f of [null, undefined, 'no es fecha']) {
      const { desde } = ventanaCandidatos(f, ahora)
      assert.equal(Math.round((ahora.getTime() - desde.getTime()) / 86_400_000), DIAS_CANDIDATOS_ATRAS)
    }
  })

  test('combina por nombre y por cercanía sin repetir, primero los por nombre', () => {
    const r = combinarCandidatos([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])
    assert.deepEqual(r.map(c => c.id), ['a', 'b', 'c'])
    assert.equal(combinarCandidatos([{ id: 'a' }], [{ id: 'b' }, { id: 'c' }], 2).length, 2)
  })

  test('el prefiltro por nombre busca cada parte, no el nombre completo', () => {
    // "Franco Jara" tiene que encontrar a "Franco Nicolás Jara": antes el
    // ILIKE '%Franco Jara%' no lo encontraba.
    assert.deepEqual(tokensParaBuscarNombre('Franco Jara'), ['franco', 'jara'])
    assert.deepEqual(tokensParaBuscarNombre('Nicolás Salerno'), ['nicolas', 'salerno'])
    assert.ok(mismoNombreVictima('Franco Jara', 'Franco Nicolás Jara'))
    assert.equal(tokensParaBuscarNombre('un joven'), null)
    assert.equal(tokensParaBuscarNombre('Franco'), null)
    assert.equal(tokensParaBuscarNombre(null), null)
  })
})

describe('prompt de deduplicación', () => {
  const noticia = {
    tipoHecho: 'Muerte bajo custodia',
    codigoSnicEstimado: '0',
    ubicacion: { provincia: 'San Juan', ciudad: 'Rawson' },
    fecha: '2026-11-18',
    titulo: 'Investigan a cinco policías por la muerte de un joven en una comisaría de San Juan',
    resumen: 'Un joven de 22 años murió en la comisaría 6ta de Rawson; cinco policías están investigados.',
    medio: 'Infobae',
    medioTipo: 'nacional' as const,
    url: 'https://www.infobae.com/x',
    nombreVictima: null,
  }
  const candidato = {
    id: 'hecho-franco',
    fechaHecho: new Date('2026-11-17T00:00:00Z'),
    nombreVictima: 'Franco Jara',
    tipoDelito: { nombre: 'Homicidios dolosos' },
    ubicacion: { provincia: 'San Juan', departamento: 'Rawson' },
    coberturas: [{
      titulo: 'Imputaron por homicidio a los cinco policías investigados por la muerte de Franco Jara',
      medio: 'Infobae',
      resumen: 'Franco Jara, de 22 años, murió en la comisaría 6ta de Rawson.',
    }],
  }
  const prompt = construirPromptDeduplicacion(noticia, [candidato])

  test('muestra víctima y resumen de los dos lados', () => {
    assert.match(prompt, /Víctima: no nombrada en la nota/)
    assert.match(prompt, /Víctima: Franco Jara/)
    assert.match(prompt, /comisaría 6ta de Rawson; cinco policías/)
    assert.match(prompt, /Resumen: Franco Jara, de 22 años/)
    assert.match(prompt, /San Juan, Rawson/)
  })

  test('explica que el seguimiento es cobertura y que el código puede diferir', () => {
    assert.match(prompt, /seguimiento/)
    assert.match(prompt, /imputaciones/)
    assert.match(prompt, /clasificación .* puede diferir/)
  })

  test('recorta textos largos de terceros', () => {
    const largo = construirPromptDeduplicacion({ ...noticia, resumen: 'palabra '.repeat(500) }, [])
    assert.ok(largo.length < 4000)
  })
})
