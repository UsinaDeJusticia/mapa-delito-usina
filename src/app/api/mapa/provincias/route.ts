export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getProvincias } from '@/lib/mapa/queries'
import { CACHE_SNIC } from '@/lib/mapa/cache-headers'

export async function GET() {
  try {
    const provincias = await getProvincias()
    return NextResponse.json({ provincias }, { headers: CACHE_SNIC })
  } catch (error) {
    console.error('Error en /api/mapa/provincias:', error)
    return NextResponse.json({ error: 'Error al obtener provincias' }, { status: 500 })
  }
}
