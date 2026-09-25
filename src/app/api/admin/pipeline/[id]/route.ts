/**
 * Detalle de una corrida del pipeline con su log incremental.
 *
 * GET ?desde=<id de línea> → la corrida + las líneas posteriores a `desde`.
 * El panel pide solo lo nuevo cada pocos segundos en lugar de bajar el log
 * entero en cada consulta (importa desde un celular con datos móviles).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { prisma } from '@/lib/mapa/queries'
import { CORRIDA_COLGADA_MS } from '@/lib/pipeline/corridas'

export const dynamic = 'force-dynamic'

const SIN_CACHE = { 'Cache-Control': 'no-store' }
const LINEAS_POR_PEDIDO = 500
const PATRON_ID = /^[0-9a-f-]{36}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: SIN_CACHE })
  }

  const { id } = await params
  if (!PATRON_ID.test(id)) {
    return NextResponse.json({ error: 'Id inválido' }, { status: 400, headers: SIN_CACHE })
  }
  const desde = Math.max(0, Number.parseInt(req.nextUrl.searchParams.get('desde') ?? '0', 10) || 0)

  try {
    const corrida = await prisma.corridaPipeline.findUnique({ where: { id } })
    if (!corrida) {
      return NextResponse.json({ error: 'No existe esa corrida' }, { status: 404, headers: SIN_CACHE })
    }

    const lineas = await prisma.corridaPipelineLinea.findMany({
      where: { corridaId: id, id: { gt: desde } },
      orderBy: { id: 'asc' },
      take: LINEAS_POR_PEDIDO + 1,
      select: { id: true, ts: true, texto: true },
    })
    const hayMas = lineas.length > LINEAS_POR_PEDIDO

    const ahora = Date.now()
    return NextResponse.json(
      {
        corrida: {
          ...corrida,
          creadaAt: corrida.creadaAt.toISOString(),
          iniciadaAt: corrida.iniciadaAt?.toISOString() ?? null,
          finalizadaAt: corrida.finalizadaAt?.toISOString() ?? null,
          latidoAt: corrida.latidoAt?.toISOString() ?? null,
          sinLatido: corrida.estado === 'en_curso' &&
            (!corrida.latidoAt || ahora - corrida.latidoAt.getTime() > CORRIDA_COLGADA_MS),
        },
        lineas: lineas.slice(0, LINEAS_POR_PEDIDO).map(l => ({ id: l.id, ts: l.ts.toISOString(), texto: l.texto })),
        hayMas,
      },
      { headers: SIN_CACHE }
    )
  } catch (error) {
    console.error('Error en GET /api/admin/pipeline/[id]:', error)
    return NextResponse.json({ error: 'No se pudo leer la corrida' }, { status: 500, headers: SIN_CACHE })
  }
}
