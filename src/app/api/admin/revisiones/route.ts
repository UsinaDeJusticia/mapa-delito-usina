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

  // Todos los hechos PRELIMINAR sin revisión registrada
  const pendientes = await prisma.$queryRaw<Array<{
    id: string
    titulo: string | null
    resumen: string | null
    medio: string | null
    provincia: string | null
    ciudad: string | null
    fecha_hecho: Date
    tipo_delito: string
    confianza: string
    requiere_revision: boolean
    url_fuente: string | null
    created_at: Date
  }>>`
    SELECT
      hd.id,
      cm.titulo,
      cm.resumen,
      cm.medio,
      u.provincia,
      u.departamento AS ciudad,
      hd.fecha_hecho,
      COALESCE(td.nombre, 'Sin clasificar') AS tipo_delito,
      hd.confianza,
      hd.requiere_revision,
      COALESCE(cm.url, hd.url_fuente) AS url_fuente,
      hd.created_at
    FROM hechos_delictivos hd
    LEFT JOIN LATERAL (
      SELECT titulo, resumen, medio, url
      FROM coberturas_mediaticas
      WHERE hecho_delictivo_id = hd.id
      ORDER BY created_at DESC
      LIMIT 1
    ) cm ON true
    LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
    LEFT JOIN tipos_delito td ON hd.tipo_delito_id = td.id
    WHERE hd.confianza = 'PRELIMINAR'
      AND NOT EXISTS (
        SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
      )
    ORDER BY hd.created_at DESC
    LIMIT ${limite} OFFSET ${offset}
  `

  const total = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::bigint AS count
    FROM hechos_delictivos hd
    WHERE hd.confianza = 'PRELIMINAR'
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
      requiere_revision: Boolean(p.requiere_revision),
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

  // Clasificación → código SNIC (null = falso positivo)
  const CLASIFICACION_SNIC: Record<string, number | null> = {
    'homicidio_doloso':                   1,
    'homicidio_en_ocasion_de_robo':       1,
    'femicidio':                          4,
    'homicidio_vinculado_al_narcotrafico': 1,
    'no_es_homicidio':                    null,
  }
  const snicCodigo = CLASIFICACION_SNIC[clasificacion_humana] ?? null
  const esHomicidio = snicCodigo !== null

  // Registrar en cola de revisiones
  await prisma.$executeRaw`
    INSERT INTO revisiones_pipeline
      (hecho_id, clasificacion_humana, revisado_por, revisado_at, notas)
    VALUES
      (${hechoIdNum}, ${clasificacion_humana}, ${revisadoPor}, NOW(), ${notas ?? null})
  `

  if (esHomicidio) {
    // Confirmado: pasar a VERIFICADO y corregir tipo_delito si el revisor lo cambió
    await prisma.$executeRaw`
      UPDATE hechos_delictivos
      SET
        confianza = 'VERIFICADO',
        requiere_revision = false,
        tipo_delito_id = COALESCE(
          (SELECT id FROM tipos_delito WHERE codigo_snic = ${String(snicCodigo)} LIMIT 1),
          tipo_delito_id
        )
      WHERE id = ${hechoIdNum}
    `
  } else {
    // Falso positivo: solo apagar el flag, queda PRELIMINAR fuera de la cola
    await prisma.$executeRaw`
      UPDATE hechos_delictivos SET requiere_revision = false WHERE id = ${hechoIdNum}
    `
  }

  return NextResponse.json({ ok: true, verificado: esHomicidio })
}
