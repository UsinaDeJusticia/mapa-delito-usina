/**
 * Reglas de las corridas: fechas en hora argentina, protocolo de eventos
 * script → agente, estado final, horario de la programada y la decisión del
 * respaldo de GitHub Actions (contra una base falsa en memoria).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENTE_VIVO_MS,
  CORRIDA_COLGADA_MS,
  claveProgramada,
  estadoFinal,
  evaluarProgramada,
  formatearEvento,
  minutosDeHora,
  parsearEvento,
  tomarProgramadaParaRespaldo,
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

describe('evaluarProgramada', () => {
  const ahora = new Date('2026-09-25T15:00:00Z')
  const hace = (ms: number) => new Date(ahora.getTime() - ms)
  const fila = (estado: string, latidoAt: Date | null = null) =>
    ({ estado, origen: 'programada', agente: 'pc-usina', latidoAt })

  test('sin fila del día, corre el respaldo', () => {
    assert.equal(evaluarProgramada(null, true, ahora).cubierta, false)
  })

  test('completada cubre el día', () => {
    assert.equal(evaluarProgramada(fila('completada'), false, ahora).cubierta, true)
  })

  test('pendiente cubre solo si hay un agente vivo que la va a tomar', () => {
    assert.equal(evaluarProgramada(fila('pendiente'), true, ahora).cubierta, true)
    const sinAgente = evaluarProgramada(fila('pendiente'), false, ahora)
    assert.equal(sinAgente.cubierta, false, 'el agente la encoló y se apagó: nadie la va a correr')
    assert.match(sinAgente.detalle, /sin ningún agente/)
  })

  test('en curso cubre mientras tenga latido', () => {
    assert.equal(evaluarProgramada(fila('en_curso', hace(60_000)), false, ahora).cubierta, true)
    assert.equal(evaluarProgramada(fila('en_curso', hace(CORRIDA_COLGADA_MS + 1)), true, ahora).cubierta, false)
    assert.equal(evaluarProgramada(fila('en_curso', null), true, ahora).cubierta, false)
  })

  test('fallida o cancelada no cubren', () => {
    for (const estado of ['fallida', 'cancelada']) {
      assert.equal(evaluarProgramada(fila(estado), true, ahora).cubierta, false, estado)
    }
  })
})

describe('tomarProgramadaParaRespaldo', () => {
  const FECHA = '2026-09-25'
  const CLAVE = claveProgramada(FECHA)
  const DATOS = { origen: 'github-actions' as const, parametros: { maxNoticias: 10 }, agente: 'github-actions' }

  interface Fila {
    id: string
    estado: string
    origen: string
    agente: string | null
    latidoAt: Date | null
    claveUnica: string | null
    parametros: unknown
  }

  type Operacion = 'findUnique' | 'create' | 'updateMany'

  /**
   * Base en memoria con lo que usa la función. `antesDe` corre una sola vez,
   * justo antes de la operación indicada: es la otra punta (el agente)
   * actuando entre la lectura y la escritura del respaldo.
   */
  function baseFalsa(inicial: Fila[], opciones: { agenteLatido?: Date; antesDe?: [Operacion, (filas: Fila[]) => void] } = {}) {
    const filas = inicial.map(f => ({ ...f }))
    let pendienteDeCorrer = opciones.antesDe
    let secuencia = 0
    const otraPunta = (op: Operacion) => {
      if (pendienteDeCorrer?.[0] === op) {
        const [, accion] = pendienteDeCorrer
        pendienteDeCorrer = undefined
        accion(filas)
      }
    }
    const db = {
      corridaPipeline: {
        async findUnique({ where }: { where: { claveUnica: string } }) {
          otraPunta('findUnique')
          const f = filas.find(x => x.claveUnica === where.claveUnica)
          return f ? { ...f } : null
        },
        async create({ data }: { data: Partial<Fila> }) {
          otraPunta('create')
          if (data.claveUnica && filas.some(x => x.claveUnica === data.claveUnica)) {
            throw Object.assign(new Error('Unique constraint failed on claveUnica'), { code: 'P2002' })
          }
          const nueva: Fila = {
            id: `nueva-${++secuencia}`, estado: 'pendiente', agente: null, latidoAt: null,
            claveUnica: null, parametros: {}, origen: 'cli', ...data,
          }
          filas.push(nueva)
          return { ...nueva }
        },
        async updateMany({ where, data }: { where: { id: string; estado: string }; data: Partial<Fila> }) {
          otraPunta('updateMany')
          const f = filas.find(x => x.id === where.id && x.estado === where.estado)
          if (!f) return { count: 0 }
          Object.assign(f, data)
          return { count: 1 }
        },
      },
      agentePipeline: {
        async findFirst({ where }: { where: { latidoAt: { gte: Date } } }) {
          const latido = opciones.agenteLatido
          return latido && latido >= where.latidoAt.gte ? { nombre: 'pc-usina' } : null
        },
      },
    }
    return { db: db as unknown as Parameters<typeof tomarProgramadaParaRespaldo>[0], filas }
  }

  const programada = (estado: string, extra: Partial<Fila> = {}): Fila => ({
    id: 'programada-hoy', estado, origen: 'programada', agente: null, latidoAt: null,
    claveUnica: CLAVE, parametros: { maxNoticias: 25 }, ...extra,
  })
  const haceUnRato = () => new Date(Date.now() - 30_000)
  const haceHoras = () => new Date(Date.now() - 3 * 60 * 60 * 1000)

  test('sin programada hoy, el respaldo se queda con la clave del día', async () => {
    const { db, filas } = baseFalsa([])
    const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
    assert.equal(r.correr, true)
    assert.equal(filas.length, 1)
    assert.equal(filas[0].claveUnica, CLAVE)
    assert.equal(filas[0].estado, 'en_curso')
    assert.equal(filas[0].agente, 'github-actions')
    assert.equal(r.correr && r.corridaId, filas[0].id)
  })

  test('si el agente crea la programada entre la lectura y el alta, el respaldo no corre en paralelo', async () => {
    // El hallazgo del review: antes, perder la carrera por la clave creaba una
    // corrida sin clave y scrapeaban los dos a la vez.
    const { db, filas } = baseFalsa([], {
      agenteLatido: haceUnRato(),
      antesDe: ['create', f => f.push(programada('pendiente', { agente: null }))],
    })
    const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
    assert.equal(r.correr, false)
    assert.equal(filas.length, 1, 'no se creó ninguna corrida paralela')
  })

  test('una programada en cola sin agente vivo la toma el respaldo', async () => {
    // El otro hallazgo: una pendiente sin latido contaba como cubierta y el
    // respaldo de las 12 salía sin hacer nada.
    const { db, filas } = baseFalsa([programada('pendiente')], { agenteLatido: haceHoras() })
    const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
    assert.equal(r.correr, true)
    assert.equal(r.correr && r.corridaId, 'programada-hoy', 'usa la misma fila: el agente ya no la va a repetir')
    assert.equal(filas.length, 1)
    assert.equal(filas[0].estado, 'en_curso')
    assert.equal(filas[0].agente, 'github-actions')
    assert.equal(filas[0].origen, 'programada')
    assert.deepEqual(filas[0].parametros, DATOS.parametros, 'el historial muestra lo que corrió de verdad')
  })

  test('una programada en cola con agente vivo cubre el día', async () => {
    const { db, filas } = baseFalsa([programada('pendiente')], { agenteLatido: haceUnRato() })
    const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
    assert.equal(r.correr, false)
    assert.equal(filas[0].estado, 'pendiente')
  })

  test('si el agente vuelve y la toma en el mismo instante, gana uno solo', async () => {
    const { db, filas } = baseFalsa([programada('pendiente')], {
      agenteLatido: haceHoras(),
      antesDe: ['updateMany', f => Object.assign(f[0], { estado: 'en_curso', agente: 'pc-usina', latidoAt: new Date() })],
    })
    const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
    assert.equal(r.correr, false)
    assert.equal(filas[0].agente, 'pc-usina')
    assert.equal(filas.length, 1)
  })

  test('una programada fallida o colgada se reemplaza con una corrida sin clave', async () => {
    for (const original of [
      programada('fallida'),
      programada('en_curso', { agente: 'pc-usina', latidoAt: new Date(Date.now() - CORRIDA_COLGADA_MS - 60_000) }),
    ]) {
      const { db, filas } = baseFalsa([original], { agenteLatido: haceUnRato() })
      const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
      assert.equal(r.correr, true, original.estado)
      assert.equal(filas.length, 2, original.estado)
      assert.equal(filas[1].claveUnica, null, 'la clave del día queda en la fila original')
      assert.equal(r.correr && r.corridaId, filas[1].id)
      assert.equal(filas[0].estado, original.estado, 'la original no se toca')
    }
  })

  test('completada o en curso con latido cubren el día', async () => {
    for (const original of [
      programada('completada'),
      programada('en_curso', { agente: 'pc-usina', latidoAt: haceUnRato() }),
    ]) {
      const { db, filas } = baseFalsa([original])
      const r = await tomarProgramadaParaRespaldo(db, FECHA, DATOS)
      assert.equal(r.correr, false, original.estado)
      assert.equal(filas.length, 1)
    }
  })

  test('un agente cuenta como vivo con latido de hace menos de AGENTE_VIVO_MS', async () => {
    const casiMuerto = new Date(Date.now() - AGENTE_VIVO_MS + 5_000)
    const { db } = baseFalsa([programada('pendiente')], { agenteLatido: casiMuerto })
    assert.equal((await tomarProgramadaParaRespaldo(db, FECHA, DATOS)).correr, false)
  })
})
