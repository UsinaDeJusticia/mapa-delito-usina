/**
 * Corre scripts/export/export_parquet.sql contra Neon y deja los Parquet en
 * public/data/.
 *
 * POR QUÉ EXISTE ESTE WRAPPER
 * El .sql arrancaba con `ATTACH getenv('DATABASE_URL') AS neon (...)`, que no
 * funciona: el parser de ATTACH en DuckDB exige un **literal de string** y
 * rechaza cualquier llamada a función. Verificado contra DuckDB 1.5.3:
 *
 *   ATTACH getenv('DATABASE_URL') …     → Parser Error: syntax error at or near "getenv"
 *   ATTACH getvariable('neon_url') …    → Parser Error: syntax error at or near "getvariable"
 *
 * O sea que la variante con `SET VARIABLE` + `getvariable()` tampoco sirve, aunque
 * `getenv()` y `getvariable()` sí funcionan como funciones en un SELECT. No es
 * que falte una función: ATTACH simplemente no acepta expresiones.
 *
 * Consecuencia práctica: `npm run export:parquet` estaba roto para cualquiera
 * que lo corriera, y el error salía como seis "Catalog neon does not exist" en
 * cascada que no apuntaban a la causa. Eso contribuyó a que el fix del hallazgo
 * #10 se quedara una semana sin aplicar a producción.
 *
 * POR QUÉ NO SE RESUELVE MÁS SIMPLE
 * La salida obvia sería inlinear la URL en el .sql, o pasarla en la línea de
 * comandos (`duckdb -c "ATTACH '$DATABASE_URL' …"`). Las dos exponen la
 * credencial de producción: la primera la escribe en disco —ya pasó una vez, con
 * un export_temp.sql improvisado—, y la segunda la deja visible en la lista de
 * procesos (`ps aux`). Acá el SQL se le pasa a DuckDB por **stdin**, así que la
 * URL no toca ni el disco ni argv.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Ruta del .sql con las consultas, relativa a la raíz del repo. */
export const RUTA_SQL = 'scripts/export/export_parquet.sql'

/**
 * Escapa un valor para interpolarlo en un literal de string de SQL.
 *
 * Importa de verdad: una contraseña de Neon puede contener una comilla simple,
 * y sin escaparla el ATTACH quedaría sintácticamente roto —o, en el peor caso,
 * ejecutaría algo que no queremos—. En SQL una comilla simple dentro de un
 * literal se escapa duplicándola.
 */
export function escaparLiteralSQL(valor: string): string {
  return valor.replace(/'/g, "''")
}

/**
 * Arma el preámbulo de conexión que va antes de las consultas del .sql.
 *
 * El preámbulo vive acá y no en el .sql justamente porque incluye la
 * credencial. El .sql queda con solo las consultas, sin nada sensible, y se
 * puede leer y revisar en el repo sin cuidado especial.
 */
export function componerPreambulo(databaseUrl: string): string {
  return [
    'INSTALL postgres;',
    'LOAD postgres;',
    `ATTACH '${escaparLiteralSQL(databaseUrl)}' AS neon (TYPE postgres, READ_ONLY);`,
  ].join('\n')
}

/** El SQL completo que se le pasa a DuckDB: preámbulo + consultas del archivo. */
export function componerSql(databaseUrl: string, sqlConsultas: string): string {
  return `${componerPreambulo(databaseUrl)}\n\n${sqlConsultas}`
}

export class FaltaDatabaseUrlError extends Error {
  constructor() {
    super(
      'Falta la variable de entorno DATABASE_URL.\n' +
        '  Uso: DATABASE_URL="postgres://…" npm run export:parquet\n' +
        '  Ojo: si usás la CLI de Neon, verificá contra qué branch apunta ' +
        '(NEON_BRANCH en .env) antes de exportar — un branch de desarrollo ' +
        'generaría Parquet con datos que no son los de producción.'
    )
    this.name = 'FaltaDatabaseUrlError'
  }
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl || databaseUrl.trim() === '') {
    // Un solo mensaje claro, en lugar de los seis errores en cascada que daba
    // antes ("Catalog neon does not exist!" × 5 + el DETACH fallando).
    console.error(`❌ ${new FaltaDatabaseUrlError().message}`)
    process.exit(1)
  }

  const raiz = process.cwd()
  const sqlConsultas = readFileSync(path.join(raiz, RUTA_SQL), 'utf-8')

  // El .sql escribe a rutas relativas (public/data/…), así que DuckDB tiene que
  // correr desde la raíz del repo o los Parquet aterrizan en otro lado.
  const resultado = spawnSync('duckdb', [], {
    input: componerSql(databaseUrl, sqlConsultas),
    cwd: raiz,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
  })

  if (resultado.error) {
    const err = resultado.error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      console.error(
        '❌ No se encontró el ejecutable `duckdb`.\n' +
          '  Instalalo: brew install duckdb — o ver https://duckdb.org/docs/installation\n' +
          '  (el paquete npm @duckdb/duckdb-wasm es el del browser, no sirve para esto)'
      )
      process.exit(1)
    }
    console.error(`❌ No se pudo ejecutar duckdb: ${err.message}`)
    process.exit(1)
  }

  process.exit(resultado.status ?? 1)
}

// Solo corre como script, no al importarlo desde un test. La comparación es por
// nombre exacto y no por `includes`: con `includes('export-parquet')` el propio
// export-parquet.test.ts activaba main(), que abortaba el proceso de test al no
// encontrar DATABASE_URL.
const invocado = path.basename(process.argv[1] ?? '')
if (invocado === 'export-parquet.ts' || invocado === 'export-parquet.js') {
  main()
}
