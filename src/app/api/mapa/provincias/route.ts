import { NextResponse } from 'next/server'
import { getProvincias } from '@/lib/mapa/queries'

export async function GET() {
  try {
    const provincias = await getProvincias()
    return NextResponse.json({ provincias })
  } catch (error) {
    console.error('Error en /api/mapa/provincias:', error)
    return NextResponse.json({ error: 'Error al obtener provincias' }, { status: 500 })
  }
}
