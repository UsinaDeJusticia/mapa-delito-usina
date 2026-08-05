/**
 * Autorización compartida de las rutas disparadas por cron.
 *
 * Antes cada ruta comparaba `authHeader !== \`Bearer ${process.env.CRON_SECRET}\``.
 * Cuando CRON_SECRET no está definido ese template produce la cadena literal
 * "Bearer undefined", así que un atacante que enviara exactamente ese header
 * quedaba autorizado: la ruta fallaba abierta. Acá se rechaza siempre que el
 * secret esté ausente, vacío o compuesto solo de espacios.
 *
 * La comparación es de tiempo constante para no filtrar el secret carácter a
 * carácter mediante diferencias de tiempo de respuesta.
 */

import { timingSafeEqual } from 'node:crypto'

/** Toda respuesta de estas rutas debe evitar cachés intermedias. */
export const SIN_CACHE = { 'Cache-Control': 'no-store' } as const

export type ResultadoAutorizacion =
  | { autorizado: true }
  | { autorizado: false; motivo: 'secret-no-configurado' | 'header-ausente' | 'header-invalido' }

const PREFIJO = 'Bearer '

function comparacionSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // timingSafeEqual exige la misma longitud. Comparar las longitudes por
  // separado filtra solo el largo del secret, no su contenido.
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Decide si una request de cron está autorizada.
 *
 * Se recibe el valor del header y el secret por parámetro (en vez de leer
 * process.env acá) para que sea testeable sin manipular el entorno global.
 *
 * @param authHeader Valor crudo del header Authorization, o null si no vino.
 * @param secret Valor de CRON_SECRET.
 */
export function autorizarCron(
  authHeader: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET
): ResultadoAutorizacion {
  // Falla cerrada: sin secret configurado nadie pasa, ni siquiera enviando
  // "Bearer undefined" o un header vacío.
  if (!secret || secret.trim() === '') {
    return { autorizado: false, motivo: 'secret-no-configurado' }
  }

  if (!authHeader) {
    return { autorizado: false, motivo: 'header-ausente' }
  }

  if (!authHeader.startsWith(PREFIJO)) {
    return { autorizado: false, motivo: 'header-invalido' }
  }

  const recibido = authHeader.slice(PREFIJO.length)
  if (!comparacionSegura(recibido, secret)) {
    return { autorizado: false, motivo: 'header-invalido' }
  }

  return { autorizado: true }
}

/**
 * Mensaje para el log del servidor. Nunca incluye el secret ni el header
 * recibido, solo la causa del rechazo.
 */
export function mensajeRechazo(motivo: Exclude<ResultadoAutorizacion, { autorizado: true }>['motivo']): string {
  switch (motivo) {
    case 'secret-no-configurado':
      return 'CRON_SECRET no está configurado: la ruta rechaza toda request por diseño'
    case 'header-ausente':
      return 'Request sin header Authorization'
    case 'header-invalido':
      return 'Header Authorization inválido'
  }
}
