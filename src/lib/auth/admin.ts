/**
 * Autorización de las rutas `/api/admin/*`.
 *
 * POR QUÉ EXISTE ESTE MÓDULO
 * El middleware protege `/admin/*` con el matcher `['/admin/:path*']`. Ese
 * patrón NO matchea `/api/admin/...`, así que las rutas de API nunca pasaron
 * por él: se autorizaban solas, y solo comprobaban `!!session?.user` — es
 * decir, "hay una sesión válida", no "esta persona sigue autorizada".
 *
 * La diferencia importa: el JWT sigue siendo criptográficamente válido después
 * de que alguien sale de ALLOWED_EMAILS. Sin revalidar, una persona a la que se
 * le quitó el acceso conservaba lectura y escritura sobre la cola de revisión
 * —incluido el POST que reclasifica hechos— hasta que su token expirara solo.
 *
 * No se resuelve extendiendo el matcher del middleware a `/api/admin/*` a
 * propósito: cuando `authorized` devuelve false, NextAuth redirige (302) a la
 * página de login. Para un fetch de la SPA eso significa recibir HTML donde
 * espera JSON, en vez de un 401 limpio que el cliente pueda manejar.
 */

import { auth } from '@/auth'
import { sesionSigueAutorizada } from '@/lib/auth/allowlist'
import type { Session } from 'next-auth'

/**
 * Devuelve la sesión solo si hay usuario Y sigue en la allowlist.
 * `null` en cualquier otro caso: quien llama responde 401.
 */
export async function requerirAdmin(): Promise<Session | null> {
  const session = await auth()
  if (!session?.user) return null

  if (!sesionSigueAutorizada(session.user.email)) {
    // Sin el email en el log: es dato personal y termina en logs del servidor.
    console.warn('Request admin rechazado: sesión válida pero fuera de la allowlist')
    return null
  }

  return session
}
