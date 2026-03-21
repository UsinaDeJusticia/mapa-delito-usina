import { NextRequest, NextResponse } from 'next/server'
import { getTendencias } from '@/lib/mapa/queries'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const codigoSnic = parseInt(searchParams.get('codigo_snic') || '1')
  const provinciaId = searchParams.get('provincia_id') || undefined

  try {
    const data = await getTendencias(codigoSnic, provinciaId)
    if (!data) {
      return NextResponse.json({ error: `Código SNIC ${codigoSnic} no encontrado` }, { status: 404 })
    }
    return NextResponse.json({ ...data, provinciaId: provinciaId || 'nacional' })
  } catch (error) {
    console.error('Error en /api/mapa/tendencias:', error)
    return NextResponse.json({ error: 'Error al obtener tendencias' }, { status: 500 })
  }
}