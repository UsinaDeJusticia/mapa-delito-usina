import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { prisma } from '@/lib/mapa/queries'
import { autorizarCron, mensajeRechazo, SIN_CACHE } from '@/lib/auth/cron'

export const dynamic = 'force-dynamic'

/**
 * Vistas materializadas a refrescar, en orden.
 *
 * mv_anios_disponibles va sin CONCURRENTLY porque no tiene índice único y
 * Postgres lo exige para esa variante. Los nombres son constantes del código,
 * nunca vienen de la request, así que no hay entrada externa en el SQL.
 */
const VISTAS = [
  { nombre: 'mv_snic_provincia', concurrently: true },
  { nombre: 'mv_snic_provincia_delito', concurrently: true },
  { nombre: 'mv_sat_provincia', concurrently: true },
  { nombre: 'mv_anios_disponibles', concurrently: false },
] as const

export async function GET() {
  const headersList = await headers()
  const auth = autorizarCron(headersList.get('authorization'))

  if (!auth.autorizado) {
    console.warn(`refresh-views rechazado: ${mensajeRechazo(auth.motivo)}`)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: SIN_CACHE }
    )
  }

  try {
    for (const vista of VISTAS) {
      const concurrently = vista.concurrently ? 'CONCURRENTLY ' : ''
      await prisma.$executeRawUnsafe(
        `REFRESH MATERIALIZED VIEW ${concurrently}${vista.nombre}`
      )
    }

    return NextResponse.json(
      {
        ok: true,
        refreshed: VISTAS.map(v => v.nombre),
        timestamp: new Date().toISOString(),
      },
      { headers: SIN_CACHE }
    )
  } catch (error) {
    console.error('Error refreshing materialized views:', error)
    return NextResponse.json(
      { ok: false, error: 'Failed to refresh views' },
      { status: 500, headers: SIN_CACHE }
    )
  }
}
