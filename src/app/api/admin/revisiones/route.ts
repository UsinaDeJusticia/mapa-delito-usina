import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/mapa/queries'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const pagina = parseInt(searchParams.get('pagina') ?? '1')
  const limite = 20
  const offset = (pagina - 1) * limite

  // Hechos con requiere_revision=true sin entrada en revisiones_pipeline
  const pendientes = await prisma.$queryRaw<Array<{
    id: string
    titulo: string | null
    provincia: string | null
    ciudad: string | null
    fecha_hecho: Date
    tipo_delito: string
    confianza: string
    url_fuente: string | null
    created_at: Date
  }>>`
    SELECT
      hd.id,
      cm.titulo,
      u.provincia,
      u.departamento AS ciudad,
      hd.fecha_hecho,
      td.nombre AS tipo_delito,
      hd.confianza,
      hd.url_fuente,
      hd.created_at
    FROM hechos_delictivos hd
    LEFT JOIN coberturas_mediaticas cm ON cm.hecho_delictivo_id = hd.id
    LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
    LEFT JOIN tipos_delito td ON hd.tipo_delito_id = td.id
    WHERE hd.requiere_revision = true
      AND NOT EXISTS (
        SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
      )
    ORDER BY hd.created_at DESC
    LIMIT ${limite} OFFSET ${offset}
  `

  const total = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM hechos_delictivos hd
    WHERE hd.requiere_revision = true
      AND NOT EXISTS (
        SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
      )
  `

  return NextResponse.json({
    pendientes: pendientes.map(p => ({
      ...p,
      id: String(p.id),
      fecha_hecho: p.fecha_hecho?.toISOString() ?? null,
      created_at: p.created_at?.toISOString() ?? null,
    })),
    total: Number(total[0]?.count ?? 0),
    pagina,
    limite,
  })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json() as {
    hecho_id: string
    clasificacion_humana: string
    notas?: string
  }

  const { hecho_id, clasificacion_humana, notas } = body

  if (!hecho_id || !clasificacion_humana) {
    return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 })
  }

  const revisadoPor = session.user.email ?? session.user.name ?? 'desconocido'
  const hechoIdNum = parseInt(hecho_id)

  // Insertar en revisiones_pipeline
  await prisma.$executeRaw`
    INSERT INTO revisiones_pipeline
      (hecho_id, clasificacion_humana, revisado_por, revisado_at, notas)
    VALUES
      (${hechoIdNum}, ${clasificacion_humana}, ${revisadoPor}, NOW(), ${notas ?? null})
  `

  // Marcar como revisado en hechos_delictivos (raw porque requiere_revision no está en Prisma client aún)
  await prisma.$executeRaw`
    UPDATE hechos_delictivos SET requiere_revision = false WHERE id = ${hechoIdNum}
  `

  return NextResponse.json({ ok: true })
}
