import { NextResponse } from 'next/server'

/**
 * Recibe las violaciones de la Content Security Policy.
 *
 * Hasta ahora "modo observación" no observaba nada: `Content-Security-
 * Policy-Report-Only` solo imprime en la consola del navegador de quien
 * esté mirando en ese momento — nadie lo estaba. Sin ningún endpoint que
 * junte esos reportes, la única forma de saber si una directiva rompería
 * algo era leer el código y adivinar.
 *
 * Esta ruta no bloquea ni decide nada: solo deja un rastro en los logs (que
 * Vercel captura) para poder mirar violaciones reales antes de mover
 * `script-src`, `connect-src`, etc. a la capa que bloquea. Ver
 * src/config/csp.mjs para las directivas que ya se movieron a bloqueo por
 * ser verificables por lectura de código, sin necesitar este dato.
 *
 * Es una ruta pública sin autenticación a propósito: el navegador la llama
 * automáticamente por el `report-uri`, sin que el usuario haga nada. El
 * único costo de que alguien la llame con basura es una línea de log de
 * más, por eso el límite de tamaño y el try/catch silencioso.
 */

export const dynamic = 'force-dynamic'

const TAMANIO_MAXIMO = 20_000 // un reporte real pesa unos pocos cientos de bytes

/** Forma mínima que nos importa de un reporte CSP `report-uri` clásico. */
interface CuerpoReporteCSP {
  'csp-report'?: {
    'document-uri'?: string
    'violated-directive'?: string
    'blocked-uri'?: string
    'effective-directive'?: string
  }
}

export async function POST(request: Request) {
  try {
    const texto = await request.text()
    if (texto.length > TAMANIO_MAXIMO) {
      console.warn(`⚠️ csp-report: cuerpo de ${texto.length} bytes descartado (excede ${TAMANIO_MAXIMO})`)
      return new NextResponse(null, { status: 204 })
    }

    const cuerpo = JSON.parse(texto) as CuerpoReporteCSP
    const reporte = cuerpo['csp-report']

    if (reporte) {
      console.warn(
        `[Report Only] Refused to load/execute — directiva=${reporte['violated-directive'] ?? reporte['effective-directive'] ?? '?'}` +
        ` bloqueado=${reporte['blocked-uri'] ?? '?'} página=${reporte['document-uri'] ?? '?'}`
      )
    }
  } catch {
    // Un cuerpo malformado o vacío no es un error del servidor: el navegador
    // manda el reporte "mejor esfuerzo", y no hay nada que reintentar acá.
  }

  return new NextResponse(null, { status: 204 })
}
