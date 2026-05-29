import { NextResponse } from 'next/server'
import { headers } from 'next/headers'

export async function GET() {
  const headersList = await headers()
  const authHeader = headersList.get('authorization')

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  try {
    // Importar y ejecutar el pipeline
    const { ejecutarPipeline } = await import(
      '@/lib/mapa/pipeline-runner'
    )
    const resultado = await ejecutarPipeline()
    return NextResponse.json({ ok: true, resultado })
  } catch (error) {
    console.error('Error en pipeline cron:', error)
    return NextResponse.json(
      { error: 'Pipeline failed' },
      { status: 500 }
    )
  }
}
