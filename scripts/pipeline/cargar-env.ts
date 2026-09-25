/**
 * Carga .env.local y .env antes que cualquier otro módulo.
 *
 * Se importa PRIMERO en los scripts del pipeline: modelos-pipeline.ts lee los
 * overrides de modelo al importarse, así que las variables tienen que estar en
 * process.env antes de que ese import corra. En GitHub Actions no hay .env y
 * esto no hace nada; dotenv tampoco pisa variables que ya vengan del entorno.
 */
import { config } from 'dotenv'

config({ path: ['.env.local', '.env'], quiet: true })
