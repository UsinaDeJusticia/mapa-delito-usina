/**
 * Panel de control del pipeline: estado y encolado de corridas.
 *
 * GET  → agentes conectados, últimas corridas y catálogo de medios por provincia
 * POST → encola una corrida (la ejecuta el agente local, no este servidor)
 *
 * Vercel no puede correr el pipeline (necesita Chrome y tarda más que cualquier
 * función serverless): esta ruta solo escribe en la cola. Ver
 * scripts/pipeline/agente-local.ts y docs/agente-local.md.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { origenPermitido } from '@/lib/auth/origen'
import { prisma } from '@/lib/mapa/queries'
import { AGENTE_VIVO_MS, CORRIDA_COLGADA_MS, encolarCorrida } from '@/lib/pipeline/corridas'
import {
  LIMITES,
  catalogoPorProvincia,
  esNacional,
  validarParametros,
} from '@/lib/pipeline/opciones-corrida'
import { MEDIOS } from '@/config/medios-pipeline'

export const dynamic = 'force-dynamic'

const SIN_CACHE = { 'Cache-Control': 'no-store' }

/** Una cola larga suele ser un doble click o un agente apagado: se frena antes. */
const MAX_PENDIENTES = 5

const CATALOGO_PROVINCIAS = catalogoPorProvincia(MEDIOS)
const CATALOGO_VALIDACION = {
  idsMedios: new Set(MEDIOS.map(m => m.id)),
  provincias: CATALOGO_PROVINCIAS.map(p => p.provincia),
}

export async function GET() {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: SIN_CACHE })
  }

  try {
    const [agentes, corridas] = await Promise.all([
      prisma.agentePipeline.findMany({ orderBy: { latidoAt: 'desc' }, take: 10 }),
      prisma.corridaPipeline.findMany({
        orderBy: { creadaAt: 'desc' },
        take: 25,
        select: {
          id: true, estado: true, origen: true, solicitadaPor: true, parametros: true,
          agente: true, progreso: true, resumen: true, error: true, exitCode: true,
          cancelacionSolicitada: true, creadaAt: true, iniciadaAt: true,
          finalizadaAt: true, latidoAt: true,
        },
      }),
    ])

    const ahora = Date.now()
    return NextResponse.json(
      {
        ahora: new Date(ahora).toISOString(),
        agentes: agentes.map(a => ({
          nombre: a.nombre,
          latidoAt: a.latidoAt.toISOString(),
          conectado: ahora - a.latidoAt.getTime() < AGENTE_VIVO_MS,
          info: a.info,
        })),
        corridas: corridas.map(c => ({
          ...c,
          creadaAt: c.creadaAt.toISOString(),
          iniciadaAt: c.iniciadaAt?.toISOString() ?? null,
          finalizadaAt: c.finalizadaAt?.toISOString() ?? null,
          latidoAt: c.latidoAt?.toISOString() ?? null,
          sinLatido: c.estado === 'en_curso' && (!c.latidoAt || ahora - c.latidoAt.getTime() > CORRIDA_COLGADA_MS),
        })),
        catalogo: {
          provincias: CATALOGO_PROVINCIAS,
          nacionales: MEDIOS.filter(m => esNacional(m) && m.activo !== false && !m.tienePaywall)
            .map(m => ({ id: m.id, nombre: m.nombre })),
          totalActivos: MEDIOS.filter(m => m.activo !== false).length,
        },
        limites: LIMITES,
      },
      { headers: SIN_CACHE }
    )
  } catch (error) {
    console.error('Error en GET /api/admin/pipeline:', error)
    // El caso típico: la migración de corridas_pipeline todavía no se aplicó.
    return NextResponse.json(
      { error: 'No se pudo leer el estado del pipeline. ¿Se aplicó la migración de corridas_pipeline?' },
      { status: 500, headers: SIN_CACHE }
    )
  }
}

export async function POST(req: NextRequest) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: SIN_CACHE })
  }
  if (!origenPermitido(req.headers, req.nextUrl.host)) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403, headers: SIN_CACHE })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'El cuerpo no es JSON válido' }, { status: 400, headers: SIN_CACHE })
  }

  const validacion = validarParametros(body, CATALOGO_VALIDACION)
  if (!validacion.ok) {
    return NextResponse.json(
      { error: 'Parámetros inválidos', detalle: validacion.errores },
      { status: 400, headers: SIN_CACHE }
    )
  }

  try {
    const pendientes = await prisma.corridaPipeline.count({ where: { estado: 'pendiente' } })
    if (pendientes >= MAX_PENDIENTES) {
      return NextResponse.json(
        { error: `Ya hay ${pendientes} corridas esperando. Esperá a que el agente las procese o cancelá alguna.` },
        { status: 409, headers: SIN_CACHE }
      )
    }

    const corrida = await encolarCorrida(prisma, {
      origen: 'panel',
      parametros: validacion.valor,
      solicitadaPor: session.user.email ?? session.user.name ?? 'desconocido',
    })

    return NextResponse.json({ ok: true, id: corrida?.id ?? null }, { status: 201, headers: SIN_CACHE })
  } catch (error) {
    console.error('Error en POST /api/admin/pipeline:', error)
    return NextResponse.json({ error: 'No se pudo encolar la corrida' }, { status: 500, headers: SIN_CACHE })
  }
}
