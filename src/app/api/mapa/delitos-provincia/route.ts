export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/mapa/queries'
import { CACHE_SNIC } from '@/lib/mapa/cache-headers'

/**
 * GET /api/mapa/delitos-provincia?provincia_id=06&anio=2024
 * 
 * Devuelve los top delitos de una provincia para un año,
 * leyendo de la materialized view mv_snic_provincia_delito.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const provinciaId = searchParams.get('provincia_id')
  const anio = parseInt(searchParams.get('anio') || '2024')

  if (!provinciaId) {
    return NextResponse.json({ error: 'provincia_id requerido' }, { status: 400 })
  }

  try {
    const rows: Array<{
      tipo_delito_nombre: string
      total_hechos: number
      total_victimas: number
    }> = await prisma.$queryRaw`
      SELECT tipo_delito_nombre, total_hechos, total_victimas
      FROM mv_snic_provincia_delito
      WHERE provincia_id = ${provinciaId} AND anio = ${anio}
      ORDER BY total_hechos DESC
      LIMIT 10
    `

    const delitos = rows.map(r => ({
      nombre: r.tipo_delito_nombre,
      hechos: Number(r.total_hechos),
      victimas: Number(r.total_victimas),
    }))

    return NextResponse.json({ delitos }, { headers: CACHE_SNIC })
  } catch (error) {
    console.error('Error en /api/mapa/delitos-provincia:', error)
    return NextResponse.json({ error: 'Error al obtener delitos' }, { status: 500 })
  }
}