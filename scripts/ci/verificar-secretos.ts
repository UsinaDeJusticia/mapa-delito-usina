/**
 * Guarda de CI: falla si algún archivo trackeado contiene una credencial real.
 *
 * Detecta URLs PostgreSQL con usuario y contraseña embebidos. El desafío es no
 * marcar los placeholders que aparecen en textos de ayuda y documentación, que
 * son legítimos. El discriminante principal es el host: una credencial real
 * apunta a un host con puntos (`ep-xxx.region.aws.neon.tech`), mientras que los
 * placeholders usan `@host/db` o `@localhost`.
 *
 * Uso:
 *   tsx scripts/ci/verificar-secretos.ts
 *
 * Salida: código 0 si está limpio, 1 si encontró algo. Nunca imprime el valor
 * detectado — solo archivo y línea, para no propagar el secreto al log de CI.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

/**
 * Requiere host con al menos un punto, lo que descarta `@host/db` y
 * `@localhost:5432` sin necesitar una lista de placeholders exhaustiva.
 */
const URL_POSTGRES_CON_CREDENCIAL =
  /postgres(?:ql)?:\/\/[^:@\s/]+:[^@\s/]+@[^\s/:]+\.[^\s/:]+/i

/** Hosts de ejemplo que igual llevan punto y no son credenciales reales. */
const HOSTS_PLACEHOLDER = [
  'example.com',
  'example.org',
  'tu-dominio',
  'tu-host',
  'host.com',
  'midominio',
]

/** Usuarios/contraseñas que delatan un placeholder incluso con host válido. */
const CREDENCIALES_PLACEHOLDER = [
  'user:pass@',
  'user:password@',
  'usuario:password@',
  'usuario:contrasena@',
  'ci:ci@',
  'postgres:postgres@',
  'usuario:clave@',
]

/** Archivos donde un placeholder es esperable y no debe fallar el build. */
const RUTAS_EXCLUIDAS = [
  /^\.env\.example$/,
  /^package-lock\.json$/,
  /^docs\//,
  /^\.github\//,
  /^scripts\/ci\/verificar-secretos\.ts$/, // este archivo contiene los patrones
]

export function estaExcluida(ruta: string): boolean {
  return RUTAS_EXCLUIDAS.some(r => r.test(ruta))
}

/**
 * true si la línea contiene una credencial PostgreSQL que parece real.
 * Exportada para poder testear la heurística sin tocar el filesystem.
 */
export function tieneCredencialReal(linea: string): boolean {
  const match = linea.match(URL_POSTGRES_CON_CREDENCIAL)
  if (!match) return false

  const encontrada = match[0].toLowerCase()

  if (CREDENCIALES_PLACEHOLDER.some(p => encontrada.includes(p))) return false
  if (HOSTS_PLACEHOLDER.some(h => encontrada.includes(h))) return false

  return true
}

export interface Hallazgo {
  ruta: string
  linea: number
}

export function buscarEnContenido(ruta: string, contenido: string): Hallazgo[] {
  const hallazgos: Hallazgo[] = []
  contenido.split('\n').forEach((linea, i) => {
    if (tieneCredencialReal(linea)) hallazgos.push({ ruta, linea: i + 1 })
  })
  return hallazgos
}

function archivosTrackeados(): string[] {
  const salida = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf-8' })
  return salida.split('\0').filter(Boolean)
}

function esBinarioOGrande(ruta: string): boolean {
  try {
    // Los .parquet, .wasm y geojson grandes no contienen credenciales y
    // leerlos completos hace lento el chequeo.
    if (/\.(parquet|wasm|ico|png|jpg|jpeg|webp|woff2?|pdf)$/i.test(ruta)) return true
    return statSync(ruta).size > 2_000_000
  } catch {
    return true
  }
}

function main(): void {
  const hallazgos: Hallazgo[] = []

  for (const ruta of archivosTrackeados()) {
    if (estaExcluida(ruta) || esBinarioOGrande(ruta)) continue
    let contenido: string
    try {
      contenido = readFileSync(ruta, 'utf-8')
    } catch {
      continue
    }
    hallazgos.push(...buscarEnContenido(ruta, contenido))
  }

  // Nunca se imprime el valor detectado, solo su ubicación.
  if (hallazgos.length > 0) {
    console.error('❌ Se encontraron credenciales en archivos trackeados:')
    for (const h of hallazgos) {
      console.error(`   ${h.ruta}:${h.linea}`)
    }
    console.error('\nRotá la credencial y sacá el archivo del árbol antes de mergear.')
    process.exit(1)
  }

  console.log('✔ Sin credenciales en archivos trackeados')
}

// Solo corre como CLI, no al importarse desde un test.
if (process.argv[1] && /verificar-secretos\.ts$/.test(process.argv[1])) {
  main()
}
