export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getTiposDelito } from '@/lib/mapa/queries'
import { CACHE_SNIC } from '@/lib/mapa/cache-headers'

export async function GET() {
  try {
    const tipos = await getTiposDelito()
    return NextResponse.json({ tipos }, { headers: CACHE_SNIC })
  } catch (error) {
    console.error('Error en /api/mapa/tipos-delito:', error)
    return NextResponse.json({ error: 'Error al obtener tipos' }, { status: 500 })
  }
}
