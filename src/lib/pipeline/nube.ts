/**
 * Agente del pipeline en Cloudflare (cloudflare/pipeline/).
 *
 * A diferencia del agente de la computadora del equipo, que queda escuchando la
 * cola, el de Cloudflare se enciende bajo demanda: a la hora de la programada
 * y cuando el panel encola una corrida. Por eso:
 * - el panel lo "despierta" después de encolar (despertarAgenteNube), y
 * - se lo considera disponible aunque su último latido tenga horas
 *   (agenteDisponible), porque entre corrida y corrida está apagado a propósito.
 */
import { AGENTE_VIVO_MS } from './corridas'

/** Un agente bajo demanda late al menos una vez por día (la programada). */
export const AGENTE_BAJO_DEMANDA_VIVO_MS = 26 * 60 * 60 * 1000

const TIMEOUT_DESPERTAR_MS = 8000

export function esBajoDemanda(info: unknown): boolean {
  return typeof info === 'object' && info !== null && (info as { bajoDemanda?: unknown }).bajoDemanda === true
}

export function agenteDisponible(agente: { latidoAt: Date; info: unknown }, ahora: number): boolean {
  const desde = ahora - agente.latidoAt.getTime()
  return desde < (esBajoDemanda(agente.info) ? AGENTE_BAJO_DEMANDA_VIVO_MS : AGENTE_VIVO_MS)
}

export type ResultadoDespertar =
  | { estado: 'sin-configurar' }
  | { estado: 'encendido' | 'ya-corriendo' }
  | { estado: 'error'; detalle: string }

/**
 * Pide al Worker de Cloudflare que encienda el agente. Nunca lanza: si falla,
 * la corrida igual quedó en la cola y la toma el agente de la computadora, el
 * próximo cron de Cloudflare o el respaldo de Actions.
 */
export async function despertarAgenteNube(
  env: Record<string, string | undefined> = process.env,
  hacerFetch: typeof fetch = fetch
): Promise<ResultadoDespertar> {
  const base = env.PIPELINE_NUBE_URL?.trim()
  const token = env.PIPELINE_NUBE_TOKEN?.trim()
  if (!base || !token) return { estado: 'sin-configurar' }

  try {
    const respuesta = await hacerFetch(new URL('/despertar', base), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_DESPERTAR_MS),
      cache: 'no-store',
    })
    if (!respuesta.ok) return { estado: 'error', detalle: `HTTP ${respuesta.status}` }
    const cuerpo = (await respuesta.json().catch(() => null)) as { estado?: unknown } | null
    if (cuerpo?.estado === 'encendido' || cuerpo?.estado === 'ya-corriendo') return { estado: cuerpo.estado }
    return { estado: 'error', detalle: 'respuesta inesperada del Worker' }
  } catch (error) {
    return { estado: 'error', detalle: String(error).slice(0, 200) }
  }
}
