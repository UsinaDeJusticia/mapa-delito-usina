/**
 * Reglas puras de las corridas: fechas en hora argentina, protocolo de eventos
 * script → agente, estado final y horario de la programada.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  claveProgramada,
  estadoFinal,
  formatearEvento,
  minutosDeHora,
  parsearEvento,
  yaEsHoraDeProgramada,
  type ResumenCorrida,
} from '../../src/lib/pipeline/corridas'
import { fechaArgentina, fechaDelHecho, horaArgentina, minutosDelDiaArgentina } from '../../src/lib/pipeline/fechas'

describe('fechas en hora argentina', () => {
  test('a las 22 hs de Argentina ya es el día siguiente en UTC, pero no acá', () => {
    // 2026-09-25 22:30 en Argentina = 2026-09-26 01:30 UTC
    const noche = new Date('2026-09-26T01:30:00Z')
    assert.equal(noche.toISOString().slice(0, 10), '2026-09-26')
    assert.equal(fechaArgentina(noche), '2026-09-25')
  })

  test('fechaDelHecho no corre el mes ni el año según la zona de la máquina', () => {
    // El bug: new Date('2026-01-01').getFullYear() en una PC de Argentina da 2025.
    const f = fechaDelHecho('2026-01-01')
    assert.equal(f.anio, 2026)
    assert.equal(f.mes, 1)
    assert.equal(f.fecha.toISOString().slice(0, 10), '2026-01-01', 'la columna DATE guarda exactamente ese día')
  })

  test('sin fecha usa el día de hoy en Argentina', () => {
    const noche = new Date('2026-09-26T01:30:00Z')
    const f = fechaDelHecho(null, noche)
    assert.equal(f.fecha.toISOString().slice(0, 10), '2026-09-25')
    assert.equal(f.mes, 9)
  })

  test('los logs muestran la hora argentina en 24 hs', () => {
    assert.equal(horaArgentina(new Date('2026-09-24T14:32:22Z')), '11:32:22')
  })

  test('minutos del día en Argentina', () => {
    assert.equal(minutosDelDiaArgentina(new Date('2026-09-24T10:00:00Z')), 7 * 60)
  })
})

describe('corrida programada', () => {
  test('clave única por día', () => {
    assert.equal(claveProgramada('2026-09-25'), 'programada:2026-09-25')
  })

  test('minutosDeHora valida el formato', () => {
    assert.equal(minutosDeHora('07:00'), 420)
    assert.equal(minutosDeHora('7:05'), 425)
    for (const malo of ['', '25:00', '07:60', 'siete', '07-00']) assert.equal(minutosDeHora(malo), null, malo)
  })

  test('recupera la programada si la computadora estaba apagada a la hora exacta', () => {
    const a_las_0659 = new Date('2026-09-25T09:59:00Z')
    const a_las_0700 = new Date('2026-09-25T10:00:00Z')
    const a_las_1500 = new Date('2026-09-25T18:00:00Z')
    assert.equal(yaEsHoraDeProgramada('07:00', a_las_0659), false)
    assert.equal(yaEsHoraDeProgramada('07:00', a_las_0700), true)
    assert.equal(yaEsHoraDeProgramada('07:00', a_las_1500), true, 'lo que evita repetirla es la clave del día')
    assert.equal(yaEsHoraDeProgramada('mal', a_las_1500), false)
  })
})

describe('protocolo de eventos', () => {
  test('un evento de progreso va y vuelve', () => {
    const evento = {
      tipo: 'progreso' as const,
      progreso: {
        totalMedios: 13, medioIndice: 3, medio: 'El Día', fase: 'extrayendo' as const,
        contadores: {
          noticiasScrapeadas: 5, hechosExtraidos: 2, hechosNuevos: 1,
          coberturasVinculadas: 1, duplicados: 0, descartados: 3,
        },
      },
    }
    const linea = formatearEvento(evento)
    assert.ok(!linea.includes('\n'), 'una sola línea')
    assert.deepEqual(parsearEvento(linea), evento)
  })

  test('las líneas comunes y los eventos mal formados no son eventos', () => {
    assert.equal(parsearEvento('✅ [07:00:01] Daemon listo'), null)
    assert.equal(parsearEvento('@@PIPELINE@@ {no es json'), null)
    assert.equal(parsearEvento('@@PIPELINE@@ {"tipo":"otro"}'), null)
  })
})

describe('estadoFinal', () => {
  const resumen = (estado: 'ok' | 'fallida', motivoFallo?: string) => ({ estado, motivoFallo }) as ResumenCorrida

  test('exit 0 con resumen ok → completada', () => {
    assert.deepEqual(estadoFinal(0, false, resumen('ok')), { estado: 'completada', error: null })
  })

  test('el resumen fallido trae el motivo real', () => {
    const r = estadoFinal(1, false, resumen('fallida', 'El proveedor LLM no responde: 400 missing x-opencode-session'))
    assert.equal(r.estado, 'fallida')
    assert.match(r.error!, /x-opencode-session/)
  })

  test('exit 0 sin resumen NO es una corrida completada', () => {
    // Es exactamente la confusión que se quiere evitar: "terminó bien" sin
    // ninguna evidencia de que haya corrido.
    assert.equal(estadoFinal(0, false, null).estado, 'fallida')
  })

  test('la cancelación manda', () => {
    assert.equal(estadoFinal(1, true, null).estado, 'cancelada')
  })
})
