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
        -- Excluye los casos cuya ÚLTIMA revisión humana dice que no son
        -- homicidio. El DISTINCT ON no es un adorno: revisiones_pipeline
        -- guarda historial, y el POST de /api/admin/revisiones SIEMPRE inserta
        -- una fila nueva (las correcciones son filas, no updates).
        --
        -- Antes esto era un NOT EXISTS sobre CUALQUIER revisión, así que un
        -- hecho marcado 'no_es_homicidio' y después CORREGIDO a 'femicidio'
        -- conservaba la fila vieja y quedaba excluido del mapa para siempre.
        -- Es exactamente lo contrario de la garantía que se busca: que
        -- reclasificar no rompa nada. El resto del repo ya usaba este patrón
        -- (ver openrouter.ts y corregir-femicidio-en-no-es-homicidio.sql);
        -- este endpoint había quedado con la versión ingenua.
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT DISTINCT ON (rp.hecho_id) rp.hecho_id, rp.clasificacion_humana
            FROM revisiones_pipeline rp
            WHERE rp.hecho_id = hd.id
            ORDER BY rp.hecho_id, rp.revisado_at DESC
          ) ultima
          WHERE ultima.clasificacion_humana = 'no_es_homicidio'
        )
        -- Código SNIC 0 = "Muerte violenta en investigación": cuerpos hallados
        -- sin causa determinada. Se guardan y van a la cola de revisión, pero
        -- no se muestran en el mapa público hasta que una persona confirme que
        -- son un homicidio. Cuando lo hace, el POST cambia tipo_delito_id al
        -- código 1 y el pin aparece solo.
        AND COALESCE(td.codigo_snic, '') <> '0'
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
