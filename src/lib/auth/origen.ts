/**
 * Chequeo de origen para las mutaciones del panel admin.
 *
 * Hoy la única defensa contra CSRF en /api/admin es el SameSite=Lax de la
 * cookie de sesión. Alcanza mientras el panel viva en su propio dominio, pero
 * deja de alcanzar si algún día se muda a un subdominio de
 * usinadejusticia.org.ar: cualquier subdominio hermano pasa a ser "same-site".
 * Las rutas que encolan o cancelan corridas del pipeline disparan trabajo en
 * la computadora del equipo, así que se exige además que el request venga de
 * la misma página.
 *
 * Los navegadores mandan `Origin` en todo POST hecho con fetch. Si falta (un
 * cliente que no es un navegador), no hay cookie de sesión que robar y la
 * autorización normal ya decide: se deja pasar.
 */
export function origenPermitido(headers: Headers, hostPedido: string): boolean {
  const origen = headers.get('origin')
  if (!origen) return true
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? hostPedido
  try {
    return new URL(origen).host === host
  } catch {
    return false
  }
}
