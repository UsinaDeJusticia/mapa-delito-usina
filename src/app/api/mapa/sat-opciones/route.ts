export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/mapa/queries'
import { CACHE_SNIC } from '@/lib/mapa/cache-headers'

/**
 * GET /api/mapa/sat-opciones
 *
 * Devuelve los valores distintos para cada filtro SAT.
 * Se cachea en el cliente — los valores no cambian frecuentemente.
 *
 * f.tipo = 'OFICIAL': este era el QUINTO camino del modo SAT y el hallazgo #10
 * se lo pasó por alto. Arregló mv_sat_provincia, mv_anios_disponibles,
 * getEstadisticasSATFiltrado y hechos_sat.parquet, pero acá las cinco consultas
 * seguían filtrando solo por es_agregado = false, que separa el agregado anual
 * del SNIC de los microdatos pero NO distingue el origen. Así que los conteos de
 * los chips de filtros —incluido el de femicidios— sumaban los casos
 * PRELIMINARES del pipeline de medios junto al dato oficial del SAT.
 *
 * El JOIN es INNER a propósito: hechos_delictivos.fuente_id es NOT NULL, así que
 * no puede descartar filas por sí mismo.
 */
export async function GET() {
  try {
    const [sexos, medios, femicidios, vinculos, lugares] = await Promise.all([
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT hd."victimaSexo" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos hd
        JOIN fuentes f ON hd.fuente_id = f.id
        WHERE hd.es_agregado = false AND f.tipo = 'OFICIAL' AND hd."victimaSexo" IS NOT NULL
        GROUP BY hd."victimaSexo" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT hd."medioComision" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos hd
        JOIN fuentes f ON hd.fuente_id = f.id
        WHERE hd.es_agregado = false AND f.tipo = 'OFICIAL' AND hd."medioComision" IS NOT NULL
        GROUP BY hd."medioComision" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT hd.femicidio AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos hd
        JOIN fuentes f ON hd.fuente_id = f.id
        WHERE hd.es_agregado = false AND f.tipo = 'OFICIAL' AND hd.femicidio IS NOT NULL
        GROUP BY hd.femicidio ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT hd."vinculoVictimaVictimario" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos hd
        JOIN fuentes f ON hd.fuente_id = f.id
        WHERE hd.es_agregado = false AND f.tipo = 'OFICIAL' AND hd."vinculoVictimaVictimario" IS NOT NULL
        GROUP BY hd."vinculoVictimaVictimario" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT hd."lugarHecho" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos hd
        JOIN fuentes f ON hd.fuente_id = f.id
        WHERE hd.es_agregado = false AND f.tipo = 'OFICIAL' AND hd."lugarHecho" IS NOT NULL
        GROUP BY hd."lugarHecho" ORDER BY total DESC
      `,
    ])

    return NextResponse.json({
      sexo: sexos.map(r => ({ valor: r.valor, total: Number(r.total) })),
      arma: medios.map(r => ({ valor: r.valor, total: Number(r.total) })),
      femicidio: femicidios.map(r => ({ valor: r.valor, total: Number(r.total) })),
      vinculo: vinculos.map(r => ({ valor: r.valor, total: Number(r.total) })),
      lugar: lugares.map(r => ({ valor: r.valor, total: Number(r.total) })),
    }, { headers: CACHE_SNIC })
  } catch (error) {
    console.error('Error en /api/mapa/sat-opciones:', error)
    return NextResponse.json({ error: 'Error al obtener opciones' }, { status: 500 })
  }
}