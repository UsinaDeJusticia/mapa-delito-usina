import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

const SIN_CACHE = { 'Cache-Control': 'no-store' }

export async function GET() {
  const headersList = await headers()
  const authHeader = headersList.get('authorization')

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
      console.error(
        '❌ Pipeline falló:',
        resultado.error,
        resultado.exitCode !== undefined ? `(exit ${resultado.exitCode})` : '',
        '\n', resultado.salida ?? ''
      )
      return NextResponse.json(
        { ok: false, error: resultado.error ?? 'Pipeline failed', resultado },
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
