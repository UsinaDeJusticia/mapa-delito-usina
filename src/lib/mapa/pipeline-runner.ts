/**
 * Wrapper para ejecutar el pipeline de scraping desde un contexto de servidor
 * (API route, cron job). Lanza scripts/pipeline/scrapear-medios.ts como
 * proceso hijo y devuelve el resumen estructurado.
 *
 * NOTA: Requiere agent-browser + Chrome instalado en el servidor.
 * En Vercel serverless no está disponible — usar un servidor dedicado o
 * GitHub Actions para el cron si se necesita el scraping real.
 */

import { execSync } from 'child_process'
import path from 'path'

export interface PipelineResultado {
  noticiasScrapeadas: number
  hechosExtraidos: number
  hechosNuevos: number
  coberturasVinculadas: number
  duplicados: number
  descartados: number
  modo: string
  error?: string
}

export async function ejecutarPipeline(
  opts: { dryRun?: boolean; maxNoticias?: number } = {}
): Promise<PipelineResultado> {
  const scriptPath = path.join(process.cwd(), 'scripts/pipeline/scrapear-medios.ts')

  const env = {
    ...process.env,
    PIPELINE_DRY_RUN: opts.dryRun ? 'true' : 'false',
    PIPELINE_MAX_NOTICIAS: String(opts.maxNoticias ?? 20),
  }

  try {
    const output = execSync(`npx tsx "${scriptPath}"`, {
      encoding: 'utf-8',
      timeout: 300_000, // 5 minutos
      env,
      stdio: 'pipe',
    })

    // El pipeline loguea el resumen como JSON en la línea que sigue a "Resumen:"
    // Ejemplo: 📊 [12:00:00] Resumen:\n    {"noticiasScrapeadas": 5, ...}
    const jsonMatch = output.match(/Resumen:[^\n]*\n\s*(\{[\s\S]*?\})/m)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1])
        return { ...parsed, modo: parsed.modo ?? (opts.dryRun ? 'DRY RUN' : 'producción') }
      } catch {
        // fallback: extraer campo a campo
      }
    }

    const get = (key: string): number => {
      const m = output.match(new RegExp(`"${key}":\\s*(\\d+)`))
      return m ? parseInt(m[1]) : 0
    }

    return {
      noticiasScrapeadas: get('noticiasScrapeadas'),
      hechosExtraidos: get('hechosExtraidos'),
      hechosNuevos: get('hechosNuevos'),
      coberturasVinculadas: get('coberturasVinculadas'),
      duplicados: get('duplicados'),
      descartados: get('descartados'),
      modo: opts.dryRun ? 'DRY RUN' : 'producción',
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      noticiasScrapeadas: 0,
      hechosExtraidos: 0,
      hechosNuevos: 0,
      coberturasVinculadas: 0,
      duplicados: 0,
      descartados: 0,
      modo: opts.dryRun ? 'DRY RUN' : 'producción',
      error: msg.slice(0, 500),
    }
  }
}
