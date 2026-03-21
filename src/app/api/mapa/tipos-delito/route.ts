import { NextResponse } from 'next/server'
import { getTiposDelito } from '@/lib/mapa/queries'

export async function GET() {
  try {
    const tipos = await getTiposDelito()
    return NextResponse.json({ tipos })
  } catch (error) {
    console.error('Error en /api/mapa/tipos-delito:', error)
    return NextResponse.json({ error: 'Error al obtener tipos' }, { status: 500 })
  }
}
