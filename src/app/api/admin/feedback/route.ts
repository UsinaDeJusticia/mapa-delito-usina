import { NextRequest, NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { prisma } from '@/lib/mapa/queries'

const CATEGORIAS_VALIDAS = ['sugerencia', 'error', 'mejora'] as const

export async function GET() {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  try {
    const items = await prisma.$queryRaw<Array<{
      id: number
      categoria: string
      mensaje: string
      autor: string
      created_at: Date
    }>>`
      SELECT id, categoria, mensaje, autor, created_at
      FROM feedback
      ORDER BY created_at DESC
      LIMIT 200
    `

    return NextResponse.json({
      items: items.map(i => ({
        ...i,
        created_at: i.created_at.toISOString(),
      })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('Error en GET /api/admin/feedback:', err)
    return NextResponse.json({ error: 'Error al obtener feedback' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function POST(req: NextRequest) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json() as { categoria?: string; mensaje?: string }
  const { categoria, mensaje } = body

  if (!categoria || !mensaje?.trim()) {
    return NextResponse.json({ error: 'Categoría y mensaje son requeridos' }, { status: 400 })
  }

  if (!CATEGORIAS_VALIDAS.includes(categoria as typeof CATEGORIAS_VALIDAS[number])) {
    return NextResponse.json({ error: 'Categoría inválida' }, { status: 400 })
  }

  const autor = session.user.email ?? session.user.name ?? 'desconocido'

  try {
    await prisma.$executeRaw`
      INSERT INTO feedback (categoria, mensaje, autor)
      VALUES (${categoria}, ${mensaje.trim()}, ${autor})
    `

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Error en POST /api/admin/feedback:', err)
    return NextResponse.json({ error: 'Error al guardar feedback' }, { status: 500 })
  }
}
