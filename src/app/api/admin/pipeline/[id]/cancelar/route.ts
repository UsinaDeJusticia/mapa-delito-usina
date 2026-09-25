/**
 * Cancela una corrida. Una pendiente se cancela en el acto; una en curso queda
 * marcada y el agente la corta en su próximo latido (cada ~3 segundos),
 * cerrando también el navegador.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { origenPermitido } from '@/lib/auth/origen'
import { prisma } from '@/lib/mapa/queries'
import { solicitarCancelacion } from '@/lib/pipeline/corridas'

export const dynamic = 'force-dynamic'

const SIN_CACHE = { 'Cache-Control': 'no-store' }
const PATRON_ID = /^[0-9a-f-]{36}$/i

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: SIN_CACHE })
  }
  if (!origenPermitido(req.headers, req.nextUrl.host)) {
    return NextResponse.json({ error: 'Origen no permitido' }, { status: 403, headers: SIN_CACHE })
  }

  const { id } = await params
  if (!PATRON_ID.test(id)) {
    return NextResponse.json({ error: 'Id inválido' }, { status: 400, headers: SIN_CACHE })
  }

  try {
    const resultado = await solicitarCancelacion(prisma, id)
    if (resultado === 'no-existe') {
      return NextResponse.json({ error: 'No existe esa corrida' }, { status: 404, headers: SIN_CACHE })
    }
    if (resultado === 'no-cancelable') {
      return NextResponse.json({ error: 'La corrida ya terminó' }, { status: 409, headers: SIN_CACHE })
    }
    return NextResponse.json({ ok: true, resultado }, { headers: SIN_CACHE })
  } catch (error) {
    console.error('Error en POST /api/admin/pipeline/[id]/cancelar:', error)
    return NextResponse.json({ error: 'No se pudo cancelar la corrida' }, { status: 500, headers: SIN_CACHE })
  }
}
