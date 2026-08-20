import { NextRequest, NextResponse } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { prisma } from '@/lib/mapa/queries'
import { efectoDeClasificacion } from '@/lib/mapa/clasificacion-humana'

export async function GET(req: NextRequest) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const pagina = Math.max(1, parseInt(searchParams.get('pagina') ?? '1') || 1)
  const limite = 20
  const offset = (pagina - 1) * limite

  try {
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
    created_at: Date
    coberturas_json: unknown
    coberturas_total: number
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
      hd.created_at,
      -- Las 12 coberturas más recientes. Si el hecho no tiene ninguna
      -- (huérfano: el pipeline crea hecho y cobertura sin transacción),
      -- cae a hd.url_fuente para que el revisor nunca quede sin fuente.
      COALESCE(
        (
          SELECT json_agg(
            json_build_object('url', t.url, 'medio', t.medio)
            ORDER BY t.created_at DESC
          )
          FROM (
            SELECT c.url, c.medio, c.created_at
            FROM coberturas_mediaticas c
            WHERE c.hecho_delictivo_id = hd.id
              AND c.url IS NOT NULL
            ORDER BY c.created_at DESC
            LIMIT 12
          ) t
        ),
        CASE
          WHEN hd.url_fuente IS NOT NULL
          THEN json_build_array(json_build_object('url', hd.url_fuente, 'medio', 'Fuente original'))
          ELSE '[]'::json
        END
      ) AS coberturas_json,
      (
        SELECT COUNT(*)::int
        FROM coberturas_mediaticas c
        WHERE c.hecho_delictivo_id = hd.id
          AND c.url IS NOT NULL
      ) AS coberturas_total
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

  // Revisados en las últimas 48h (más reciente por hecho)
  const revisados = await prisma.$queryRaw<Array<{
    hecho_id: string
    titulo: string | null
    medio: string | null
    provincia: string | null
    confianza_hecho: string
    clasificacion_humana: string
    revisado_por: string
    revisado_at: Date
    coberturas_json: unknown
    coberturas_total: number
  }>>`
    SELECT DISTINCT ON (rp.hecho_id)
      hd.id::text AS hecho_id,
      cm.titulo,
      cm.medio,
      u.provincia,
      hd.confianza AS confianza_hecho,
      rp.clasificacion_humana,
      rp.revisado_por,
      rp.revisado_at,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object('url', t.url, 'medio', t.medio)
            ORDER BY t.created_at DESC
          )
          FROM (
            SELECT c.url, c.medio, c.created_at
            FROM coberturas_mediaticas c
            WHERE c.hecho_delictivo_id = hd.id
              AND c.url IS NOT NULL
            ORDER BY c.created_at DESC
            LIMIT 12
          ) t
        ),
        CASE
          WHEN hd.url_fuente IS NOT NULL
          THEN json_build_array(json_build_object('url', hd.url_fuente, 'medio', 'Fuente original'))
          ELSE '[]'::json
        END
      ) AS coberturas_json,
      (
        SELECT COUNT(*)::int
        FROM coberturas_mediaticas c
        WHERE c.hecho_delictivo_id = hd.id
          AND c.url IS NOT NULL
      ) AS coberturas_total
    FROM revisiones_pipeline rp
    JOIN hechos_delictivos hd ON hd.id = rp.hecho_id
    LEFT JOIN LATERAL (
      SELECT titulo, medio, url
      FROM coberturas_mediaticas
      WHERE hecho_delictivo_id = hd.id
      ORDER BY created_at DESC
      LIMIT 1
    ) cm ON true
    LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
    WHERE rp.revisado_at >= NOW() - INTERVAL '48 hours'
    ORDER BY rp.hecho_id, rp.revisado_at DESC
    LIMIT 50
  `

  return NextResponse.json({
    pendientes: pendientes.map(p => ({
      ...p,
      id: String(p.id),
      fecha_hecho: p.fecha_hecho?.toISOString() ?? null,
      created_at: p.created_at?.toISOString() ?? null,
      requiere_revision: Boolean(p.requiere_revision),
      coberturas: (p.coberturas_json as Array<{ url: string; medio: string | null }> | null) ?? [],
      coberturas_total: Number(p.coberturas_total ?? 0),
      coberturas_json: undefined,
    })),
    total: Number(total[0]?.count ?? 0),
    pagina,
    limite,
    revisados: revisados.map(r => ({
      ...r,
      hecho_id: String(r.hecho_id),
      revisado_at: r.revisado_at?.toISOString() ?? null,
      coberturas: (r.coberturas_json as Array<{ url: string; medio: string | null }> | null) ?? [],
      coberturas_total: Number(r.coberturas_total ?? 0),
      coberturas_json: undefined,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('Error en GET /api/admin/revisiones:', err)
    return NextResponse.json({ error: 'Error al obtener revisiones' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function POST(req: NextRequest) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await req.json() as {
    hecho_id: string
    clasificacion_humana: string
    notas?: string
  }

  // `es_correccion` se quitó del contrato. El front lo mandaba y el backend lo
  // declaraba en el tipo pero nunca lo leía: era una promesa falsa en la API.
  // Y no hace falta: revisiones_pipeline guarda historial, así que si ya existe
  // una fila para ese hecho, esta revisión ES una corrección — se deduce del
  // dato en vez de confiar en lo que diga el cliente. Se sigue aceptando en el
  // body sin romper nada (queda ignorado explícitamente).
  const { hecho_id, clasificacion_humana, notas } = body

  if (!hecho_id || !clasificacion_humana) {
    return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 })
  }

  const revisadoPor = session.user.email ?? session.user.name ?? 'desconocido'

  // Efecto de la clasificación (código SNIC + condición de femicidio) — ver
  // src/lib/mapa/clasificacion-humana.ts para el mapeo completo y por qué está
  // compartido con el circuito de aprendizaje del pipeline (few-shot).
  const { snicCodigo, esFemicidio } = efectoDeClasificacion(clasificacion_humana)
  const esHomicidio = snicCodigo !== null

  try {
    // Los dos statements van en una transacción: si el UPDATE falla, la
    // revisión no queda registrada. Antes iban sueltos, así que un fallo del
    // segundo dejaba una fila en revisiones_pipeline sin efecto sobre el hecho
    // — y como el resto del sistema deriva el estado de la ÚLTIMA revisión, el
    // caso quedaba contado como revisado sin haber cambiado nada. El pipeline
    // ya usaba $transaction para esto mismo.
    await prisma.$transaction(async tx => {
    // url_fuente es NOT NULL en revisiones_pipeline. La poblamos con la URL de
    // la cobertura más reciente del hecho (o la url_fuente del hecho), con
    // fallback a 'revision-manual' para no violar el constraint nunca.
    await tx.$executeRaw`
      INSERT INTO revisiones_pipeline
        (hecho_id, url_fuente, clasificacion_humana, revisado_por, revisado_at, notas)
      SELECT
        ${hecho_id},
        COALESCE(
          (SELECT url FROM coberturas_mediaticas
             WHERE hecho_delictivo_id = ${hecho_id}
             ORDER BY created_at DESC LIMIT 1),
          (SELECT url_fuente FROM hechos_delictivos WHERE id = ${hecho_id}),
          'revision-manual'
        ),
        ${clasificacion_humana}, ${revisadoPor}, NOW(), ${notas ?? null}
    `

    if (esHomicidio) {
      // femicidio se escribe con el mismo formato que la ingesta del SAT ('Si' o
      // NULL) para que las vistas que cuentan femicidio = 'Si' incluyan también
      // los casos revisados a mano.
      await tx.$executeRaw`
        UPDATE hechos_delictivos
        SET
          confianza = 'VERIFICADO',
          requiere_revision = false,
          femicidio = ${esFemicidio ? 'Si' : null},
          tipo_delito_id = COALESCE(
            (SELECT id FROM tipos_delito WHERE codigo_snic = ${String(snicCodigo)} LIMIT 1),
            tipo_delito_id
          )
        WHERE id = ${hecho_id}
      `
    } else {
      // esHomicidio=false (hoy solo 'no_es_homicidio'): femicidio es un
      // subtipo de homicidio, así que si un humano dice "esto no es un
      // homicidio" la condición de femicidio queda descartada sin ambigüedad.
      // ANTES este UPDATE no tocaba femicidio ni tipo_delito_id: un caso que
      // una persona ya confirmó como "no es homicidio" podía quedar guardado
      // con femicidio='Si' de una clasificación anterior. tipo_delito_id NO
      // se toca acá — es NOT NULL en el esquema y el catálogo SNIC no tiene
      // un código para "no es un hecho delictivo"; queda como decisión aparte
      // (agregar un código sentinela, o volver la columna nullable).
      await tx.$executeRaw`
        UPDATE hechos_delictivos
        SET
          confianza = CASE WHEN confianza = 'VERIFICADO' THEN 'PRELIMINAR' ELSE confianza END,
          requiere_revision = false,
          femicidio = null
        WHERE id = ${hecho_id}
      `
    }
    })
  } catch (err) {
    console.error('Error en POST /api/admin/revisiones:', err)
    return NextResponse.json({ error: 'Error al guardar la revisión' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, verificado: esHomicidio })
}
