import { NextRequest, NextResponse } from 'next/server'
import { getEstadisticasPorProvincia, getEstadisticasSATFiltrado, FuenteDatos } from '@/lib/mapa/queries'
import { CACHE_SNIC, CACHE_MEDIOS } from '@/lib/mapa/cache-headers'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const anio = parseInt(searchParams.get('anio') || '2024')
  const tipoDelitoId = searchParams.get('tipo_delito_id') || undefined
  const fuente = (searchParams.get('fuente') || 'snic') as FuenteDatos

  // Filtros SAT
  const sexo = searchParams.get('sexo') || undefined
  const arma = searchParams.get('arma') || undefined
  const vinculo = searchParams.get('vinculo') || undefined
  const lugar = searchParams.get('lugar') || undefined

  try {
    let data

    if (fuente === 'sat' && (sexo || arma || vinculo || lugar)) {
      // SAT con filtros → query directa a hechos_delictivos
      data = await getEstadisticasSATFiltrado(anio, { sexo, arma, vinculo, lugar })
    } else {
      // SNIC o SAT sin filtros → materialized views
      data = await getEstadisticasPorProvincia(anio, tipoDelitoId, fuente)
    }

    const cacheHeaders = fuente === 'snic' ? CACHE_SNIC : CACHE_MEDIOS
    return NextResponse.json({
      anio,
      fuente,
      ...data,
      totalRegistros: data.provincias.length,
    }, { headers: cacheHeaders })
  } catch (error) {
    console.error('Error en /api/mapa/estadisticas:', error)
    return NextResponse.json({ error: 'Error al obtener estadísticas' }, { status: 500 })
  }
}