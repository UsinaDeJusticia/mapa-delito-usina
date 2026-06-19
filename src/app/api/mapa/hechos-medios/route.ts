export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/mapa/queries'

export async function GET() {
  const hechos = await prisma.$queryRaw<Array<{
    id: string
    titulo: string | null
    medio: string | null
    url_cobertura: string | null
    provincia: string | null
    ciudad: string | null
    latitud: number
    longitud: number
    fecha_hecho: Date | null
    confianza: string
    tipo_delito: string | null
  }>>`
    SELECT * FROM (
      SELECT DISTINCT ON (hd.id)
        hd.id::text,
        cm.titulo,
        cm.medio,
        cm.url AS url_cobertura,
        u.provincia,
        u.departamento AS ciudad,
        u.latitud,
        u.longitud,
        hd.fecha_hecho,
        hd.confianza::text,
        td.nombre AS tipo_delito
      FROM hechos_delictivos hd
      LEFT JOIN coberturas_mediaticas cm ON cm.hecho_delictivo_id = hd.id
      LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
      LEFT JOIN tipos_delito td ON hd.tipo_delito_id = td.id
      WHERE hd.confianza IN ('VERIFICADO', 'PRELIMINAR')
        AND hd.es_agregado = false
        AND u.latitud IS NOT NULL
        AND u.longitud IS NOT NULL
        AND hd.fecha_hecho >= NOW() - INTERVAL '90 days'
        AND NOT EXISTS (
          SELECT 1 FROM revisiones_pipeline rp
          WHERE rp.hecho_id = hd.id
            AND rp.clasificacion_humana = 'no_es_homicidio'
        )
      ORDER BY hd.id, cm.created_at DESC
    ) sub
    ORDER BY sub.fecha_hecho DESC
    LIMIT 500
  `

  const response = NextResponse.json({
    hechos: hechos.map(h => ({
      ...h,
      id: String(h.id),
      fecha_hecho: h.fecha_hecho?.toISOString().slice(0, 10) ?? null,
      latitud: Number(h.latitud),
      longitud: Number(h.longitud),
    })),
    total: hechos.length,
  })

  response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
  return response
}
