/**
 * Allowlist de emails para el panel admin.
 *
 * La lógica vivía inline en los callbacks de NextAuth, así que no se podía
 * testear sin instanciar todo el framework. Acá quedan funciones puras.
 *
 * Sobre normalización Unicode: se aplica NFC y no NFKC a propósito. NFC unifica
 * secuencias que representan exactamente el mismo carácter (una "é" precompuesta
 * y una "e" + acento combinante), lo cual es correcto para comparar identidades.
 * NFKC además unifica caracteres visualmente parecidos pero distintos — por
 * ejemplo la "ａ" de ancho completo con la "a" ASCII — y para una allowlist eso
 * significaría aceptar direcciones que no son las autorizadas. Los homóglifos de
 * otros alfabetos (la "а" cirílica) tampoco se unifican con ninguna forma, y así
 * debe ser.
 */

/** Separa y normaliza la variable de entorno ALLOWED_EMAILS. */
export function parsearAllowlist(crudo: string | undefined | null): string[] {
  if (!crudo) return []
  return crudo
    .split(',')
    .map(normalizarEmail)
    .filter((e): e is string => e !== null)
}

/**
 * Normaliza un email para comparación: recorta, aplica NFC y baja a minúsculas.
 * Devuelve null si no queda nada utilizable.
 */
export function normalizarEmail(valor: string | undefined | null): string | null {
  if (typeof valor !== 'string') return null
  const limpio = valor.trim().normalize('NFC').toLowerCase()
  return limpio.length > 0 ? limpio : null
}

export interface ContextoAutorizacion {
  /** Lista ya parseada de emails autorizados. */
  allowlist: readonly string[]
  /** true en producción. Con allowlist vacía cambia el resultado. */
  esProduccion: boolean
}

export type ResultadoAllowlist =
  | { permitido: true }
  | { permitido: false; motivo: 'sin-email' | 'allowlist-vacia-en-produccion' | 'email-no-autorizado' }

/**
 * Decide si un email puede iniciar sesión en el panel admin.
 *
 * Con allowlist vacía falla cerrada en producción: un despliegue al que se le
 * olvidó configurar ALLOWED_EMAILS no queda abierto a cualquier cuenta de
 * Google. En desarrollo se permite para no bloquear el trabajo local.
 */
export function evaluarAllowlist(
  email: string | undefined | null,
  { allowlist, esProduccion }: ContextoAutorizacion
): ResultadoAllowlist {
  const normalizado = normalizarEmail(email)
  if (normalizado === null) {
    // Sin email no hay identidad que comparar: el proveedor falló o no lo devolvió.
    return { permitido: false, motivo: 'sin-email' }
  }

  if (allowlist.length === 0) {
    return esProduccion
      ? { permitido: false, motivo: 'allowlist-vacia-en-produccion' }
      : { permitido: true }
  }

  return allowlist.includes(normalizado)
    ? { permitido: true }
    : { permitido: false, motivo: 'email-no-autorizado' }
}

/**
 * Decide si una ruta requiere sesión.
 *
 * Nota: por ahora solo verifica que haya sesión, igual que antes. Revalidar la
 * allowlist en cada request está previsto para la Fase 3 del plan; hacerlo acá
 * cambiaría el comportamiento de sesiones ya emitidas y queda fuera del alcance
 * de esta fase de contención.
 */
export function requiereSesion(pathname: string): boolean {
  return pathname.startsWith('/admin')
}

export function puedeAcceder(pathname: string, estaLogueado: boolean): boolean {
  return requiereSesion(pathname) ? estaLogueado : true
}
