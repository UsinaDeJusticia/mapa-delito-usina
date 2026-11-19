/**
 * Dolosos vs. no dolosos en la capa de casos de medios.
 *
 * El pipeline acepta los códigos SNIC 0–4 (ver prisma/seed.ts). El 0 (muerte
 * en investigación) no se publica hasta que alguien lo revisa. Del resto, el
 * mapa público distingue:
 * - dolosos: 1 (homicidio doloso, incluye femicidios) y 2 (tentativa);
 * - no dolosos: 3 (siniestros viales) y 4 (homicidios culposos por otros
 *   hechos). Se muestran en gris y con la aclaración "No doloso", para que no
 *   se lean como homicidios intencionales.
 */
export const CODIGOS_NO_DOLOSOS = ['3', '4'] as const

export function esNoDoloso(codigoSnic: string | null | undefined): boolean {
  return codigoSnic != null && (CODIGOS_NO_DOLOSOS as readonly string[]).includes(codigoSnic.trim())
}
