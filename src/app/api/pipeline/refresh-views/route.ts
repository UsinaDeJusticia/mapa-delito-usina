import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { prisma } from '@/lib/mapa/queries'

export async function GET() {
  const headersList = await headers()
  const authHeader = headersList.get('authorization')

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  try {
    await prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_snic_provincia`)
    await prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_snic_provincia_delito`)
    await prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sat_provincia`)
    // mv_anios_disponibles has no unique index, so CONCURRENTLY is not supported
    await prisma.$executeRawUnsafe(`REFRESH MATERIALIZED VIEW mv_anios_disponibles`)

    return NextResponse.json({
      ok: true,
      refreshed: [
        'mv_snic_provincia',
        'mv_snic_provincia_delito',
        'mv_sat_provincia',
        'mv_anios_disponibles',
      ],
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Error refreshing materialized views:', error)
    return NextResponse.json(
      { error: 'Failed to refresh views' },
      { status: 500 }
    )
  }
}
