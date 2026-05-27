import { NextResponse } from 'next/server'
import { prisma } from '@/lib/mapa/queries'
import { CACHE_SNIC } from '@/lib/mapa/cache-headers'

/**
 * GET /api/mapa/sat-opciones
 *
 * Devuelve los valores distintos para cada filtro SAT.
 * Se cachea en el cliente — los valores no cambian frecuentemente.
 */
export async function GET() {
  try {
    const [sexos, medios, femicidios, vinculos, lugares] = await Promise.all([
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT "victimaSexo" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos
        WHERE es_agregado = false AND "victimaSexo" IS NOT NULL
        GROUP BY "victimaSexo" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT "medioComision" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos
        WHERE es_agregado = false AND "medioComision" IS NOT NULL
        GROUP BY "medioComision" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT femicidio AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos
        WHERE es_agregado = false AND femicidio IS NOT NULL
        GROUP BY femicidio ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT "vinculoVictimaVictimario" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos
        WHERE es_agregado = false AND "vinculoVictimaVictimario" IS NOT NULL
        GROUP BY "vinculoVictimaVictimario" ORDER BY total DESC
      `,
      prisma.$queryRaw<Array<{ valor: string; total: number }>>`
        SELECT "lugarHecho" AS valor, COUNT(*)::int AS total
        FROM hechos_delictivos
        WHERE es_agregado = false AND "lugarHecho" IS NOT NULL
        GROUP BY "lugarHecho" ORDER BY total DESC
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