import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { autorizarCron, mensajeRechazo, SIN_CACHE } from '@/lib/auth/cron'

export const dynamic = 'force-dynamic'

export async function GET() {
  const headersList = await headers()
  const auth = autorizarCron(headersList.get('authorization'))

  if (!auth.autorizado) {
    console.warn(`pipeline/run rechazado: ${mensajeRechazo(auth.motivo)}`)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: SIN_CACHE }
    )
  }

  try {
    // Importar y ejecutar el pipeline
    const { ejecutarPipeline } = await import(
      '@/lib/mapa/pipeline-runner'
    )
    const resultado = await ejecutarPipeline()

    // ejecutarPipeline no lanza cuando el proceso hijo muere: devuelve
    // ok: false con el detalle. Sin este chequeo un pipeline caído respondía
    // HTTP 200 { ok: true } con todos los contadores en cero, y cualquier
    // monitoreo que mire el status lo veía como una corrida exitosa.
    if (!resultado.ok) {
      const { salida, ...resultadoPublico } = resultado
      console.error(
        '❌ Pipeline falló:',
        resultado.error,
        resultado.exitCode !== undefined ? `(exit ${resultado.exitCode})` : '',
        '\n', salida ?? ''
      )
      return NextResponse.json(
        {
          ok: false,
          error: resultado.error ?? 'Pipeline failed',
          resultado: resultadoPublico,
        },
        { status: 500, headers: SIN_CACHE }
      )
    }

    return NextResponse.json({ ok: true, resultado }, { headers: SIN_CACHE })
  } catch (error) {
    console.error('Error en pipeline cron:', error)
    return NextResponse.json(
      { ok: false, error: 'Pipeline failed' },
      { status: 500, headers: SIN_CACHE }
    )
  }
}
