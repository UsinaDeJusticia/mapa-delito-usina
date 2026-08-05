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
  /**
   * false si el proceso murió, se pasó del timeout, o terminó sin emitir un
   * resumen legible. Quien llame DEBE mirar este campo: los contadores en cero
   * no distinguen "corrió y no encontró nada" de "no llegó a correr".
   */
  ok: boolean
  noticiasScrapeadas: number
  hechosExtraidos: number
  hechosNuevos: number
  coberturasVinculadas: number
  duplicados: number
  descartados: number
  modo: string
  /** true si los contadores salieron del resumen real del pipeline */
  resumenLeido: boolean
  error?: string
  exitCode?: number
  /** Cola de stdout/stderr para diagnosticar sin entrar al servidor */
  salida?: string
}

const CONTADORES_EN_CERO = {
  noticiasScrapeadas: 0,
  hechosExtraidos: 0,
  hechosNuevos: 0,
  coberturasVinculadas: 0,
  duplicados: 0,
  descartados: 0,
}

type Contadores = typeof CONTADORES_EN_CERO

/**
 * Extrae los contadores del stdout del pipeline.
 * Devuelve null si no hay resumen — distinto de un resumen con todo en cero.
 */
function parsearResumen(output: string): Contadores | null {
  // El pipeline loguea el resumen como JSON en la línea que sigue a "Resumen:"
  // Ejemplo: 📊 [12:00:00] Resumen:\n    {"noticiasScrapeadas": 5, ...}
  const jsonMatch = output.match(/Resumen:[^\n]*\n\s*(\{[\s\S]*?\})/m)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Partial<Contadores>
      return { ...CONTADORES_EN_CERO, ...parsed }
    } catch {
      // sigue al fallback campo a campo
    }
  }

  // Fallback: buscar cada campo suelto. Solo cuenta si apareció al menos uno;
  // si no apareció ninguno el pipeline no llegó a emitir el resumen.
  const get = (key: string): number | null => {
    const m = output.match(new RegExp(`"${key}":\\s*(\\d+)`))
    return m ? parseInt(m[1]) : null
  }
  const crudos = {
    noticiasScrapeadas: get('noticiasScrapeadas'),
    hechosExtraidos: get('hechosExtraidos'),
    hechosNuevos: get('hechosNuevos'),
    coberturasVinculadas: get('coberturasVinculadas'),
    duplicados: get('duplicados'),
    descartados: get('descartados'),
  }
  if (Object.values(crudos).every(v => v === null)) return null

  return Object.fromEntries(
    Object.entries(crudos).map(([k, v]) => [k, v ?? 0])
  ) as Contadores
}

function cola(texto: string, max = 2000): string {
  return texto.length > max ? '…' + texto.slice(-max) : texto
}

export async function ejecutarPipeline(
  opts: { dryRun?: boolean; maxNoticias?: number } = {}
): Promise<PipelineResultado> {
  const scriptPath = path.join(process.cwd(), 'scripts/pipeline/scrapear-medios.ts')
  const modo = opts.dryRun ? 'DRY RUN' : 'producción'

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

    const resumen = parsearResumen(output)

    // Exit code 0 pero sin resumen: el script terminó de forma inesperada.
    // Reportarlo como fallo en lugar de devolver ceros que parecen éxito.
    if (!resumen) {
      return {
        ok: false,
        ...CONTADORES_EN_CERO,
        modo,
        resumenLeido: false,
        error: 'El pipeline terminó sin emitir un resumen legible',
        salida: cola(output),
      }
    }

    return { ok: true, ...resumen, modo, resumenLeido: true }

  } catch (error) {
    // execSync adjunta stdout/stderr y el exit code al error. El pipeline puede
    // haber procesado noticias antes de morir, así que intentamos rescatar el
    // resumen parcial — pero el resultado sigue siendo ok: false.
    const e = error as { message?: string; status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer }
    const stdout = e.stdout ? String(e.stdout) : ''
    const stderr = e.stderr ? String(e.stderr) : ''
    const resumen = parsearResumen(stdout)

    return {
      ok: false,
      ...(resumen ?? CONTADORES_EN_CERO),
      modo,
      resumenLeido: resumen !== null,
      exitCode: typeof e.status === 'number' ? e.status : undefined,
      error: (e.message ?? String(error)).slice(0, 500),
      salida: cola([stdout, stderr].filter(Boolean).join('\n--- stderr ---\n')),
    }
  }
}
