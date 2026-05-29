import { NextRequest } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/mapa/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const POLL_INTERVAL_MS = 4000
// Cierra la conexión antes del límite de Vercel para que el cliente reconecte limpiamente
const MAX_DURATION_MS = 270_000

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user) {
    return new Response('No autorizado', { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const desdeParam = searchParams.get('desde')
  let desde = desdeParam ? new Date(desdeParam) : new Date(Date.now() - 60_000)

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
            WHERE rp.revisado_at > ${desde}
            ORDER BY rp.revisado_at ASC
          `

          if (nuevas.length > 0) {
            desde = nuevas[nuevas.length - 1].revisado_at

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
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
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
