import { NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { prisma } from '@/lib/mapa/queries'

export async function GET() {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  let resumenSemanas: Array<{ semana: string; scrapeados: bigint; verificados: bigint; preliminares: bigint; falsos_positivos: bigint }>
  let precisionPorMedio: Array<{ medio: string; total: bigint; verificados: bigint; falsos_positivos: bigint }>
  let ultimasCorridas: [{ total_pipeline: bigint; verificados: bigint; preliminares: bigint; revisados: bigint }]
  let pendientes: [{ pendientes: bigint }]

  try {
    ;[resumenSemanas, precisionPorMedio, ultimasCorridas, pendientes] = await Promise.all([

    // Resumen semanal: scrapeados, extraídos, verificados, descartados.
    //
    // Solo hechos de la fuente periodística: `es_agregado = false` también
    // incluye los ~16.700 microdatos oficiales del SAT, que se contaban como
    // "scrapeados" (en la semana de cada reingesta, y en el total siempre).
    // Las semanas se cortan en hora argentina: DATE_TRUNC sobre la columna en
    // UTC cerraba la semana el domingo a las 21 hs.
    prisma.$queryRaw<Array<{
      semana: string
      scrapeados: bigint
      verificados: bigint
      preliminares: bigint
      falsos_positivos: bigint
    }>>`
      SELECT
        TO_CHAR(DATE_TRUNC('week', hd.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires'), 'DD/MM') AS semana,
        COUNT(*) AS scrapeados,
        COUNT(*) FILTER (WHERE hd.confianza = 'VERIFICADO') AS verificados,
        COUNT(*) FILTER (WHERE hd.confianza = 'PRELIMINAR') AS preliminares,
        COUNT(*) FILTER (
          WHERE hd.confianza = 'PRELIMINAR'
          AND EXISTS (
            SELECT 1 FROM revisiones_pipeline rp
            WHERE rp.hecho_id = hd.id
              AND rp.clasificacion_humana = 'no_es_homicidio'
          )
        ) AS falsos_positivos
      FROM hechos_delictivos hd
      JOIN fuentes f ON f.id = hd.fuente_id AND f.tipo = 'PERIODISTICA'
      WHERE hd.es_agregado = false
        AND hd.created_at >= NOW() - INTERVAL '8 weeks'
      GROUP BY 1, DATE_TRUNC('week', hd.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')
      ORDER BY DATE_TRUNC('week', hd.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires') DESC
      LIMIT 8
    `,

    // Precisión por medio (últimos 30 días)
    prisma.$queryRaw<Array<{
      medio: string
      total: bigint
      verificados: bigint
      falsos_positivos: bigint
    }>>`
      SELECT
        cm.medio,
        COUNT(DISTINCT hd.id) AS total,
        COUNT(DISTINCT hd.id) FILTER (WHERE hd.confianza = 'VERIFICADO') AS verificados,
        COUNT(DISTINCT rp.hecho_id) FILTER (
          WHERE rp.clasificacion_humana = 'no_es_homicidio'
        ) AS falsos_positivos
      FROM coberturas_mediaticas cm
      JOIN hechos_delictivos hd ON cm.hecho_delictivo_id = hd.id
      LEFT JOIN revisiones_pipeline rp ON rp.hecho_id = hd.id
      WHERE hd.es_agregado = false
        AND hd.created_at >= NOW() - INTERVAL '30 days'
        AND cm.medio IS NOT NULL
      GROUP BY cm.medio
      ORDER BY total DESC
      LIMIT 20
    `,

    // Totales generales. COUNT(DISTINCT): el LEFT JOIN con revisiones_pipeline
    // da una fila por revisión, y cada corrección contaba el hecho dos veces.
    prisma.$queryRaw<[{
      total_pipeline: bigint
      verificados: bigint
      preliminares: bigint
      revisados: bigint
    }]>`
      SELECT
        COUNT(DISTINCT hd.id) AS total_pipeline,
        COUNT(DISTINCT hd.id) FILTER (WHERE hd.confianza = 'VERIFICADO') AS verificados,
        COUNT(DISTINCT hd.id) FILTER (WHERE hd.confianza = 'PRELIMINAR') AS preliminares,
        COUNT(DISTINCT rp.hecho_id) AS revisados
      FROM hechos_delictivos hd
      JOIN fuentes f ON f.id = hd.fuente_id AND f.tipo = 'PERIODISTICA'
      LEFT JOIN revisiones_pipeline rp ON rp.hecho_id = hd.id
      WHERE hd.es_agregado = false
    `,

    // Pendientes de revisión
    prisma.$queryRaw<[{ pendientes: bigint }]>`
      SELECT COUNT(*)::bigint AS pendientes
      FROM hechos_delictivos hd
      JOIN fuentes f ON f.id = hd.fuente_id AND f.tipo = 'PERIODISTICA'
      WHERE hd.confianza = 'PRELIMINAR'
        AND hd.es_agregado = false
        AND NOT EXISTS (
          SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
        )
    `,
    ])
  } catch (err) {
    console.error('Error en /api/admin/metricas:', err)
    return NextResponse.json(
      { error: 'Error al obtener métricas' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const totales = ultimasCorridas[0]

  return NextResponse.json({
    totales: {
      totalPipeline: Number(totales?.total_pipeline ?? 0),
      verificados: Number(totales?.verificados ?? 0),
      preliminares: Number(totales?.preliminares ?? 0),
      revisados: Number(totales?.revisados ?? 0),
      pendientes: Number(pendientes[0]?.pendientes ?? 0),
    },
    semanas: resumenSemanas.map(s => ({
      semana: s.semana,
      scrapeados: Number(s.scrapeados),
      verificados: Number(s.verificados),
      preliminares: Number(s.preliminares),
      falsosPositivos: Number(s.falsos_positivos),
    })),
    medios: precisionPorMedio.map(m => ({
      medio: m.medio,
      total: Number(m.total),
      verificados: Number(m.verificados),
      falsosPositivos: Number(m.falsos_positivos),
      precision: Number(m.total) > 0
        ? Math.round((Number(m.verificados) / Number(m.total)) * 100)
        : null,
    })),
  // no-store, como toda ruta admin (CLAUDE.md §9). Antes era
  // `private, s-maxage=900`: s-maxage no hace nada junto a private, y el
  // navegador podía mostrar métricas de hasta media hora atrás justo después
  // de una corrida o una tanda de revisiones.
  }, { headers: { 'Cache-Control': 'no-store' } })
}
