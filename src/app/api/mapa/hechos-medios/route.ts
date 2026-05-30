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
    SELECT
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
    LEFT JOIN LATERAL (
      SELECT titulo, medio, url
      FROM coberturas_mediaticas
      WHERE hecho_delictivo_id = hd.id
      ORDER BY created_at DESC
      LIMIT 1
    ) cm ON true
    LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
    LEFT JOIN tipos_delito td ON hd.tipo_delito_id = td.id
    WHERE hd.confianza IN ('VERIFICADO', 'PRELIMINAR')
      AND hd.es_agregado = false
      AND u.latitud IS NOT NULL
      AND u.longitud IS NOT NULL
      AND hd.fecha_hecho >= NOW() - INTERVAL '90 days'
    ORDER BY hd.fecha_hecho DESC
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
