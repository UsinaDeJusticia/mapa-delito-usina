import { NextRequest } from 'next/server'
import { requerirAdmin } from '@/lib/auth/admin'
import { prisma } from '@/lib/mapa/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 4000
// Cierra la conexión antes del límite de Vercel para que el cliente reconecte limpiamente
const MAX_DURATION_MS = 270_000

export async function GET(req: NextRequest) {
  const session = await requerirAdmin()
  if (!session?.user) {
    return new Response('No autorizado', { status: 401 })
  }

  // Cursor por id (SERIAL), no por revisado_at.
  //
  // ANTES el cursor era `desde = última.revisado_at`, un Date de JS con
  // milisegundos, mientras revisado_at se guarda con NOW() en microsegundos:
  // `revisado_at > desde` volvía a encontrar la misma fila en cada poll y la
  // re-emitía cada 4 segundos. Con dos revisores, el contador de pendientes
  // del otro bajaba 1 cada 4 s hasta que el polling de 30 s lo corregía.
  //
  // Cada evento lleva `id:`, así que cuando la conexión se corta (Vercel a los
  // 270 s) el navegador reconecta mandando Last-Event-ID y se retoma justo
  // donde quedó, en vez de re-enviar todo desde que se abrió la página.
  const { searchParams } = new URL(req.url)
  const ultimoIdHeader = Number.parseInt(req.headers.get('last-event-id') ?? '', 10)
  let ultimoId: number
  if (Number.isFinite(ultimoIdHeader) && ultimoIdHeader >= 0) {
    ultimoId = ultimoIdHeader
  } else {
    const desdeParam = searchParams.get('desde')
    const pedido = desdeParam ? new Date(desdeParam).getTime() : NaN
    // Nunca más de 24 h hacia atrás: `desde=1970-01-01` volcaba todo el historial.
    const piso = Date.now() - 24 * 60 * 60 * 1000
    const desde = new Date(Number.isFinite(pedido) ? Math.max(pedido, piso) : Date.now() - 60_000)
    try {
      const fila = await prisma.$queryRaw<[{ max: number | null }]>`
        SELECT MAX(id)::int AS max FROM revisiones_pipeline WHERE revisado_at <= ${desde}
      `
      ultimoId = fila[0]?.max ?? 0
    } catch {
      return new Response('No se pudo iniciar el stream', { status: 500 })
    }
  }

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      // Enviar ping inicial para confirmar conexión
      controller.enqueue(encoder.encode(`: conectado\n\n`))

      const intervalo = setInterval(async () => {
        if (closed) return

        try {
          const nuevas = await prisma.$queryRaw<Array<{
            id: number
            hecho_id: string
            clasificacion_humana: string
            revisado_por: string
            revisado_at: Date
            titulo: string | null
            medio: string | null
            provincia: string | null
            confianza_hecho: string
          }>>`
            SELECT
              rp.id::int AS id,
              rp.hecho_id::text,
              rp.clasificacion_humana,
              rp.revisado_por,
              rp.revisado_at,
              cm.titulo,
              cm.medio,
              u.provincia,
              hd.confianza AS confianza_hecho
            FROM revisiones_pipeline rp
            JOIN hechos_delictivos hd ON hd.id = rp.hecho_id
            LEFT JOIN LATERAL (
              SELECT titulo, medio
              FROM coberturas_mediaticas
              WHERE hecho_delictivo_id = hd.id
              ORDER BY created_at DESC
              LIMIT 1
            ) cm ON true
            LEFT JOIN ubicaciones u ON hd.ubicacion_id = u.id
            WHERE rp.id > ${ultimoId}
            ORDER BY rp.id ASC
            LIMIT 100
          `

          if (nuevas.length > 0) {
            ultimoId = nuevas[nuevas.length - 1].id

            for (const r of nuevas) {
              const payload = JSON.stringify({
                tipo: 'revision',
                hecho_id: r.hecho_id,
                clasificacion_humana: r.clasificacion_humana,
                revisado_por: r.revisado_por,
                revisado_at: r.revisado_at.toISOString(),
                titulo: r.titulo ?? null,
                medio: r.medio ?? null,
                provincia: r.provincia ?? null,
                confianza_hecho: r.confianza_hecho,
              })
              controller.enqueue(encoder.encode(`id: ${r.id}\ndata: ${payload}\n\n`))
            }
          } else {
            // Heartbeat para mantener la conexión viva
            controller.enqueue(encoder.encode(`: heartbeat\n\n`))
          }
        } catch {
          // Si la BD falla, el cliente sigue conectado y reintenta en el próximo ciclo
        }
      }, POLL_INTERVAL_MS)

      // Cerrar limpiamente antes del límite de Vercel
      setTimeout(() => {
        closed = true
        clearInterval(intervalo)
        try { controller.close() } catch { /* ya cerrado */ }
      }, MAX_DURATION_MS)

      // Detectar desconexión del cliente
      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(intervalo)
        try { controller.close() } catch { /* ya cerrado */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
