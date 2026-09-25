/**
 * Opciones de una corrida del pipeline: qué medios, con qué foco geográfico,
 * cuánta profundidad y si escribe o no en la base.
 *
 * Tres lugares arman o leen estas opciones y tienen que coincidir:
 * - el panel /admin/pipeline, que valida lo que manda el formulario;
 * - el agente local, que convierte los parámetros guardados en argumentos;
 * - scrapear-medios.ts, que lee esos argumentos.
 * Por eso viven juntas y son funciones puras: se testean sin base ni browser.
 */

/** Lo mínimo de un medio que hace falta para seleccionarlo. MedioConfig lo cumple. */
export interface MedioSeleccionable {
  id: string
  nombre: string
  provincia?: string
  tipo?: 'provincial' | 'nacional'
  activo?: boolean
  tienePaywall?: boolean
}

export interface ParametrosCorrida {
  /** Ids puntuales. Si hay alguno, manda sobre `provincias`. */
  medios: string[]
  /** Provincias en foco, como figuran en MEDIOS (src/config/medios-pipeline.ts). Vacío = corrida completa. */
  provincias: string[]
  /** Sumar los medios nacionales (Infobae y otros) a una corrida por provincias. */
  incluirNacionales: boolean
  /**
   * Sumar los medios de esas provincias que todavía no se verificaron
   * (`activo: false` sin paywall). Pueden fallar; por eso es opt-in. Solo
   * aplica a corridas por provincia: sobre todo el país serían ~100 medios.
   */
  incluirNoVerificados: boolean
  /** Localidades o zonas que el identificador tiene que priorizar. */
  foco: string[]
  /** Noticias a visitar por medio. */
  maxNoticias: number
  /** true = no escribe en la base. */
  dryRun: boolean
}

export const LIMITES = {
  maxNoticias: { min: 1, max: 25, porDefecto: 10 },
  foco: { items: 8, largo: 60 },
  medios: 60,
  provincias: 24,
} as const

export const PARAMETROS_POR_DEFECTO: ParametrosCorrida = {
  medios: [],
  provincias: [],
  incluirNacionales: true,
  incluirNoVerificados: false,
  foco: [],
  maxNoticias: LIMITES.maxNoticias.porDefecto,
  dryRun: false,
}

/** Minúsculas, sin tildes y con espacios colapsados: "Tucumán " == "tucuman". */
export function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function esNacional(m: MedioSeleccionable): boolean {
  return m.tipo === 'nacional' || !m.provincia || normalizarTexto(m.provincia) === 'nacional'
}

/**
 * Deja un texto de foco apto para ir al prompt: sin caracteres de control ni
 * comillas (el foco lo escribe una persona del equipo, pero termina dentro de
 * un prompt y no tiene por qué poder cerrar comillas ni meter saltos de línea).
 */
export function limpiarFoco(item: string): string {
  return item
    .replace(/[\u0000-\u001f\u007f"'`<>{}[\]\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITES.foco.largo)
}

function listaDeTexto(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor.filter((v): v is string => typeof v === 'string')
  if (typeof valor === 'string') return valor.split(',')
  return []
}

function sinRepetidos(items: string[]): string[] {
  const vistos = new Set<string>()
  return items.filter(i => {
    const k = normalizarTexto(i)
    if (!k || vistos.has(k)) return false
    vistos.add(k)
    return true
  })
}

export interface CatalogoValidacion {
  idsMedios: ReadonlySet<string>
  /** Provincias válidas, con el nombre canónico que usa MEDIOS. */
  provincias: readonly string[]
}

export type ResultadoValidacion =
  | { ok: true; valor: ParametrosCorrida }
  | { ok: false; errores: string[] }

/**
 * Valida parámetros que vienen de afuera (el body del panel, o una fila de la
 * base leída por el agente). Nunca confía en la forma: todo campo se chequea.
 */
export function validarParametros(crudo: unknown, catalogo: CatalogoValidacion): ResultadoValidacion {
  const errores: string[] = []
  const obj = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>

  const medios = sinRepetidos(listaDeTexto(obj.medios).map(s => s.trim()))
  if (medios.length > LIMITES.medios) errores.push(`demasiados medios (máximo ${LIMITES.medios})`)
  const desconocidos = medios.filter(id => !catalogo.idsMedios.has(id))
  if (desconocidos.length > 0) errores.push(`medios desconocidos: ${desconocidos.slice(0, 5).join(', ')}`)

  const canonicas = new Map(catalogo.provincias.map(p => [normalizarTexto(p), p]))
  const provinciasPedidas = sinRepetidos(listaDeTexto(obj.provincias))
  if (provinciasPedidas.length > LIMITES.provincias) errores.push('demasiadas provincias')
  const provincias: string[] = []
  for (const p of provinciasPedidas) {
    const canonica = canonicas.get(normalizarTexto(p))
    if (canonica) provincias.push(canonica)
    else errores.push(`provincia sin medios configurados: ${p.slice(0, 40)}`)
  }

  const foco = sinRepetidos(listaDeTexto(obj.foco).map(limpiarFoco))
  if (foco.length > LIMITES.foco.items) errores.push(`demasiadas zonas de foco (máximo ${LIMITES.foco.items})`)

  let maxNoticias: number = LIMITES.maxNoticias.porDefecto
  if (obj.maxNoticias !== undefined) {
    const n = Number(obj.maxNoticias)
    if (!Number.isInteger(n) || n < LIMITES.maxNoticias.min || n > LIMITES.maxNoticias.max) {
      errores.push(`maxNoticias debe ser un entero entre ${LIMITES.maxNoticias.min} y ${LIMITES.maxNoticias.max}`)
    } else {
      maxNoticias = n
    }
  }

  const booleano = (clave: string, porDefecto: boolean): boolean => {
    const v = obj[clave]
    if (v === undefined) return porDefecto
    if (typeof v !== 'boolean') errores.push(`${clave} debe ser true o false`)
    return v === true
  }

  const valor: ParametrosCorrida = {
    medios,
    provincias,
    incluirNacionales: booleano('incluirNacionales', PARAMETROS_POR_DEFECTO.incluirNacionales),
    incluirNoVerificados: booleano('incluirNoVerificados', PARAMETROS_POR_DEFECTO.incluirNoVerificados),
    foco: foco.slice(0, LIMITES.foco.items),
    maxNoticias,
    dryRun: booleano('dryRun', PARAMETROS_POR_DEFECTO.dryRun),
  }

  return errores.length > 0 ? { ok: false, errores } : { ok: true, valor }
}

/**
 * Parámetros → argumentos de scrapear-medios.ts. Cada valor viaja como un
 * único elemento de argv (el agente lanza el proceso sin shell), así que un
 * espacio o una coma dentro de un nombre de provincia no rompen nada.
 */
export function argumentosDesdeParametros(p: ParametrosCorrida): string[] {
  const args: string[] = []
  if (p.medios.length > 0) args.push(`--medios=${p.medios.join(',')}`)
  if (p.provincias.length > 0) {
    args.push(`--provincias=${p.provincias.join(',')}`)
    if (p.incluirNacionales) args.push('--incluir-nacionales')
    if (p.incluirNoVerificados) args.push('--incluir-no-verificados')
  }
  if (p.foco.length > 0) args.push(`--foco=${p.foco.join(',')}`)
  args.push(`--max-noticias=${p.maxNoticias}`)
  if (p.dryRun) args.push('--dry-run')
  return args
}

/**
 * Lado del script: argv (+ las env vars históricas) → parámetros.
 *
 * Acepta también `--medio=X`, el flag de siempre (npm run pipeline:infobae, el
 * input del workflow): equivale a `--medios=X`.
 */
export function parametrosDesdeArgumentos(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
): ParametrosCorrida {
  const valorDe = (flag: string): string | undefined =>
    argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const tiene = (flag: string) => argv.includes(flag)
  const lista = (flag: string) => (valorDe(flag) ?? '').split(',').map(s => s.trim()).filter(Boolean)

  const medios = sinRepetidos([...lista('--medios'), ...lista('--medio')])

  const crudoMax = valorDe('--max-noticias') ?? env.PIPELINE_MAX_NOTICIAS
  const n = Number(crudoMax)
  const maxNoticias = Number.isInteger(n)
    ? Math.min(LIMITES.maxNoticias.max, Math.max(LIMITES.maxNoticias.min, n))
    : LIMITES.maxNoticias.porDefecto

  return {
    medios,
    provincias: sinRepetidos(lista('--provincias')),
    incluirNacionales: tiene('--incluir-nacionales'),
    incluirNoVerificados: tiene('--incluir-no-verificados'),
    foco: sinRepetidos(lista('--foco').map(limpiarFoco)).slice(0, LIMITES.foco.items),
    maxNoticias,
    dryRun: tiene('--dry-run') || env.PIPELINE_DRY_RUN === 'true',
  }
}

/**
 * Qué medios visita una corrida.
 *
 * - Con `medios`: exactamente esos, estén activos o no (igual que `--medio=`,
 *   que siempre sirvió para probar un medio desactivado).
 * - Con `provincias`: los de esas provincias que estén activos (más los no
 *   verificados si se pidió, nunca los de paywall), y los nacionales activos
 *   si se pidió.
 * - Sin nada: todos los activos, la corrida diaria de siempre.
 */
export function seleccionarMedios<M extends MedioSeleccionable>(
  medios: readonly M[],
  p: ParametrosCorrida
): { seleccionados: M[]; desconocidos: string[] } {
  if (p.medios.length > 0) {
    const porId = new Map(medios.map(m => [m.id, m]))
    const seleccionados = p.medios.map(id => porId.get(id)).filter((m): m is M => Boolean(m))
    return { seleccionados, desconocidos: p.medios.filter(id => !porId.has(id)) }
  }

  if (p.provincias.length > 0) {
    const enFoco = new Set(p.provincias.map(normalizarTexto))
    const seleccionados = medios.filter(m => {
      if (m.tienePaywall) return false
      if (esNacional(m)) return p.incluirNacionales && m.activo !== false
      if (!m.provincia || !enFoco.has(normalizarTexto(m.provincia))) return false
      return m.activo !== false || p.incluirNoVerificados
    })
    return { seleccionados, desconocidos: [] }
  }

  return { seleccionados: medios.filter(m => m.activo !== false), desconocidos: [] }
}

export interface ProvinciaCatalogo {
  provincia: string
  activos: number
  noVerificados: number
  medios: Array<{ id: string; nombre: string; activo: boolean }>
}

/** Resumen por provincia para el formulario del panel (sin nacionales ni paywall). */
export function catalogoPorProvincia(medios: readonly MedioSeleccionable[]): ProvinciaCatalogo[] {
  const porProvincia = new Map<string, ProvinciaCatalogo>()
  for (const m of medios) {
    if (esNacional(m) || m.tienePaywall || !m.provincia) continue
    const entrada = porProvincia.get(m.provincia) ?? {
      provincia: m.provincia, activos: 0, noVerificados: 0, medios: [],
    }
    const activo = m.activo !== false
    if (activo) entrada.activos++
    else entrada.noVerificados++
    entrada.medios.push({ id: m.id, nombre: m.nombre, activo })
    porProvincia.set(m.provincia, entrada)
  }
  return Array.from(porProvincia.values()).sort((a, b) => a.provincia.localeCompare(b.provincia, 'es'))
}

/** Descripción corta del alcance, para el historial y los logs. */
export function describirAlcance(p: ParametrosCorrida): string {
  const partes: string[] = []
  if (p.medios.length > 0) partes.push(`medios: ${p.medios.join(', ')}`)
  else if (p.provincias.length > 0) {
    partes.push(p.provincias.join(', '))
    if (p.incluirNacionales) partes.push('+ nacionales')
    if (p.incluirNoVerificados) partes.push('+ no verificados')
  } else partes.push('todos los medios activos')
  if (p.foco.length > 0) partes.push(`foco: ${p.foco.join(', ')}`)
  return partes.join(' · ')
}
