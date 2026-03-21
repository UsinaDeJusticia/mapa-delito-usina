import { NextRequest, NextResponse } from 'next/server'
import { getEstadisticasPorProvincia } from '@/lib/mapa/queries'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const anio = parseInt(searchParams.get('anio') || '2024')
  const tipoDelitoId = searchParams.get('tipo_delito_id') || undefined

  try {
    const data = await getEstadisticasPorProvincia(anio, tipoDelitoId)
    return NextResponse.json({ anio, ...data, totalRegistros: data.provincias.length })
  } catch (error) {
    console.error('Error en /api/mapa/estadisticas:', error)
    return NextResponse.json({ error: 'Error al obtener estadísticas' }, { status: 500 })
  }
}
