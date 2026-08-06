/**
 * Validación runtime de las respuestas del LLM.
 *
 * Antes el pipeline hacía `JSON.parse(x) as LLMRespuesta`. Un cast de
 * TypeScript no valida nada en runtime: fechas, confianza, cantidades,
 * clasificaciones y `candidatoId` podían ser cualquier cosa y se convertían
 * directamente en decisiones de negocio — qué se inserta en la base, con qué
 * tipo de delito y si se fusiona con un hecho existente.
 *
 * El contenido que alimenta estos prompts viene de sitios de terceros, así que
 * es entrada hostil por defecto. Una respuesta que no valida produce un error
 * explícito o marca el caso para revisión humana; nunca se acepta a medias.
 *
 * No se usa una librería de schemas para no agregar dependencias a un PR de
 * contención. Los validadores son explícitos y están cubiertos por tests.
 */

// ════════════════════════════════════════════
// RESULTADO DE VALIDACIÓN
// ════════════════════════════════════════════

export type Validacion<T> =
  | { ok: true; valor: T }
  | { ok: false; errores: string[] }

function fallo<T>(...errores: string[]): Validacion<T> {
  return { ok: false, errores }
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ════════════════════════════════════════════
// PRIMITIVAS
// ════════════════════════════════════════════

/** Límites de longitud para texto que va a la base o a un log. */
export const LARGO_MAX = {
  titulo: 500,
  resumen: 4000,
  provincia: 120,
  localidad: 160,
  barrio: 240,
  razon: 600,
  nombreVictima: 200,
} as const

export function textoOpcional(
  v: unknown,
  campo: string,
  maxLargo: number
): Validacion<string | null> {
  if (v === null || v === undefined || v === '') return { ok: true, valor: null }
  if (typeof v !== 'string') return fallo(`${campo}: se esperaba string o null`)
  const limpio = v.trim()
  if (limpio.length === 0) return { ok: true, valor: null }
  if (limpio.length > maxLargo) {
    return fallo(`${campo}: excede ${maxLargo} caracteres`)
  }
  // Los caracteres de control rompen logs y pueden falsear salidas de terminal.
  // Se permiten tab (09), LF (0A) y CR (0D), legítimos dentro de un resumen.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(limpio)) {
    return fallo(`${campo}: contiene caracteres de control`)
  }
  return { ok: true, valor: limpio }
}

export function enteroEnRango(
  v: unknown,
  campo: string,
  min: number,
  max: number
): Validacion<number> {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return fallo(`${campo}: se esperaba número finito`)
  }
  if (!Number.isInteger(v)) return fallo(`${campo}: se esperaba entero`)
  if (v < min || v > max) return fallo(`${campo}: fuera del rango [${min}, ${max}]`)
  return { ok: true, valor: v }
}

/**
 * Fecha ISO `YYYY-MM-DD` razonable: no anterior a 1990 ni posterior a mañana.
 * El pipeline procesa hechos recientes; una fecha de 1200 o de 2090 es una
 * alucinación del modelo, no un dato.
 */
export function fechaRazonable(
  v: unknown,
  campo: string,
  hoy: Date = new Date()
): Validacion<string | null> {
  if (v === null || v === undefined || v === '') return { ok: true, valor: null }
  if (typeof v !== 'string') return fallo(`${campo}: se esperaba string o null`)

  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return fallo(`${campo}: formato inválido, se esperaba YYYY-MM-DD`)

  const [, aStr, mStr, dStr] = m
  const anio = Number(aStr)
  const mes = Number(mStr)
  const dia = Number(dStr)

  // Rechaza fechas calendariamente imposibles como 2026-02-31.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  if (
    fecha.getUTCFullYear() !== anio ||
    fecha.getUTCMonth() !== mes - 1 ||
    fecha.getUTCDate() !== dia
  ) {
    return fallo(`${campo}: fecha inexistente en el calendario`)
  }

  if (anio < 1990) return fallo(`${campo}: anterior a 1990`)

  // Se tolera un día de margen por husos horarios.
  const manana = new Date(hoy.getTime() + 24 * 60 * 60 * 1000)
  if (fecha.getTime() > manana.getTime()) {
    return fallo(`${campo}: fecha futura`)
  }

  return { ok: true, valor: `${aStr}-${mStr}-${dStr}` }
}

// ════════════════════════════════════════════
// 1. IDENTIFICACIÓN DE LINKS
// ════════════════════════════════════════════

export interface LinkIdentificado {
  ref: string
  titulo: string
}

/** El formato de ref de agent-browser. Duplicado a propósito para no acoplar. */
const PATRON_REF = /^e[0-9]+$/
const MAX_LINKS = 10

/**
 * Valida el array que devuelve el prompt de identificación de links.
 *
 * Descarta entradas inválidas en lugar de rechazar todo el lote: si el modelo
 * devuelve nueve links buenos y uno con un ref hostil, se aprovechan los nueve.
 * Cada descarte se reporta en `descartados` para poder observarlo.
 */
export function validarLinksIdentificados(
  crudo: unknown
): { links: LinkIdentificado[]; descartados: string[] } {
  if (!Array.isArray(crudo)) {
    return { links: [], descartados: ['la respuesta no es un array'] }
  }

  const links: LinkIdentificado[] = []
  const descartados: string[] = []
  const refsVistos = new Set<string>()

  // Índice explícito en vez de .entries(): el tsconfig del proyecto no fija
  // target, así que iterar el iterador requeriría downlevelIteration.
  for (let i = 0; i < crudo.length; i++) {
    const item: unknown = crudo[i]
    if (links.length >= MAX_LINKS) {
      descartados.push(`se ignoraron ${crudo.length - i} entradas por exceder el máximo de ${MAX_LINKS}`)
      break
    }
    if (!esObjeto(item)) {
      descartados.push(`entrada ${i}: no es un objeto`)
      continue
    }
    if (typeof item.ref !== 'string' || !PATRON_REF.test(item.ref)) {
      // No se incluye el valor: puede venir de un sitio hostil.
      descartados.push(`entrada ${i}: ref no cumple ^e[0-9]+$`)
      continue
    }
    if (refsVistos.has(item.ref)) {
      descartados.push(`entrada ${i}: ref duplicado`)
      continue
    }
    const titulo = textoOpcional(item.titulo, `entrada ${i}.titulo`, LARGO_MAX.titulo)
    if (!titulo.ok) {
      descartados.push(titulo.errores.join('; '))
      continue
    }
    if (titulo.valor === null) {
      descartados.push(`entrada ${i}: titulo vacío`)
      continue
    }

    refsVistos.add(item.ref)
    links.push({ ref: item.ref, titulo: titulo.valor })
  }

  return { links, descartados }
}

// ════════════════════════════════════════════
// 2. EXTRACCIÓN DE NOTICIA
// ════════════════════════════════════════════

/** Códigos SNIC que el prompt de extracción puede devolver. */
export const CODIGOS_SNIC_VALIDOS = [0, 1, 2, 3, 4] as const
export type CodigoSnic = (typeof CODIGOS_SNIC_VALIDOS)[number]

export interface ExtraccionValidada {
  esHechoDelictivo: boolean
  snicCodigo: CodigoSnic | null
  provincia: string | null
  localidad: string | null
  barrioODireccion: string | null
  fechaHecho: string | null
  cantidadVictimas: number | null
  resumenHecho: string | null
  nombreVictima: string | null
  /** Femicidio no es un código SNIC; se marca aparte. Ver el prompt. */
  esFemicidio: boolean
  requiereRevision: boolean
  confianzaExtraccion: number
}

/**
 * Valida la respuesta del prompt de extracción.
 *
 * `esHechoDelictivo` y `confianzaExtraccion` son obligatorios porque de ellos
 * depende si el caso se inserta. El resto puede ser null: un hecho sin
 * localidad exacta sigue siendo utilizable.
 */
export function validarExtraccion(
  crudo: unknown,
  hoy: Date = new Date()
): Validacion<ExtraccionValidada> {
  if (!esObjeto(crudo)) return fallo('la respuesta no es un objeto')

  const errores: string[] = []

  if (typeof crudo.esHechoDelictivo !== 'boolean') {
    errores.push('esHechoDelictivo: se esperaba boolean')
  }

  // La confianza decide si el caso pasa el umbral: tiene que ser un número real.
  const confianza = enteroEnRango(crudo.confianzaExtraccion, 'confianzaExtraccion', 0, 100)
  if (!confianza.ok) errores.push(...confianza.errores)

  let snicCodigo: CodigoSnic | null = null
  if (crudo.snic_codigo !== null && crudo.snic_codigo !== undefined) {
    if (
      typeof crudo.snic_codigo !== 'number' ||
      !CODIGOS_SNIC_VALIDOS.includes(crudo.snic_codigo as CodigoSnic)
    ) {
      errores.push(`snic_codigo: debe ser uno de ${CODIGOS_SNIC_VALIDOS.join(', ')} o null`)
    } else {
      snicCodigo = crudo.snic_codigo as CodigoSnic
    }
  }

  const provincia = textoOpcional(crudo.provincia, 'provincia', LARGO_MAX.provincia)
  if (!provincia.ok) errores.push(...provincia.errores)

  const localidad = textoOpcional(crudo.localidad, 'localidad', LARGO_MAX.localidad)
  if (!localidad.ok) errores.push(...localidad.errores)

  const barrio = textoOpcional(crudo.barrio_o_direccion, 'barrio_o_direccion', LARGO_MAX.barrio)
  if (!barrio.ok) errores.push(...barrio.errores)

  const resumen = textoOpcional(crudo.resumen_hecho, 'resumen_hecho', LARGO_MAX.resumen)
  if (!resumen.ok) errores.push(...resumen.errores)

  const nombreVictima = textoOpcional(crudo.nombre_victima, 'nombre_victima', LARGO_MAX.nombreVictima)
  if (!nombreVictima.ok) errores.push(...nombreVictima.errores)

  const fecha = fechaRazonable(crudo.fecha_hecho, 'fecha_hecho', hoy)
  if (!fecha.ok) errores.push(...fecha.errores)

  // Cantidad de víctimas: positiva y con tope defensivo. Un valor de 10.000 es
  // una alucinación, no una masacre.
  let cantidadVictimas: number | null = null
  if (crudo.cantidad_victimas !== null && crudo.cantidad_victimas !== undefined) {
    const cv = enteroEnRango(crudo.cantidad_victimas, 'cantidad_victimas', 1, 100)
    if (!cv.ok) errores.push(...cv.errores)
    else cantidadVictimas = cv.valor
  }

  if (errores.length > 0) return { ok: false, errores }

  return {
    ok: true,
    valor: {
      esHechoDelictivo: crudo.esHechoDelictivo as boolean,
      snicCodigo,
      provincia: provincia.ok ? provincia.valor : null,
      localidad: localidad.ok ? localidad.valor : null,
      barrioODireccion: barrio.ok ? barrio.valor : null,
      fechaHecho: fecha.ok ? fecha.valor : null,
      cantidadVictimas,
      resumenHecho: resumen.ok ? resumen.valor : null,
      nombreVictima: nombreVictima.ok ? nombreVictima.valor : null,
      // Solo el boolean exacto cuenta: un "true" string o un 1 no alcanzan para
      // marcar un caso como femicidio.
      esFemicidio: crudo.es_femicidio === true,
      requiereRevision: crudo.requiereRevision === true,
      confianzaExtraccion: confianza.ok ? confianza.valor : 0,
    },
  }
}

// ════════════════════════════════════════════
// 3. DEDUPLICACIÓN
// ════════════════════════════════════════════

export interface DeduplicacionValidada {
  esNuevo: boolean
  candidatoId: string | null
  confianza: number
  razon: string
}

/**
 * Valida la respuesta del prompt de deduplicación.
 *
 * La regla crítica: si el modelo dice que es cobertura de un hecho existente,
 * `candidatoId` tiene que pertenecer al conjunto que se le envió. Sin esta
 * verificación un ID alucinado o inyectado podía vincular la nueva cobertura a
 * un hecho arbitrario de la base.
 *
 * @param idsCandidatos IDs que efectivamente se enviaron al modelo.
 */
export function validarDeduplicacion(
  crudo: unknown,
  idsCandidatos: readonly string[]
): Validacion<DeduplicacionValidada> {
  if (!esObjeto(crudo)) return fallo('la respuesta no es un objeto')

  const errores: string[] = []

  if (typeof crudo.esNuevo !== 'boolean') {
    errores.push('esNuevo: se esperaba boolean')
  }

  const confianza = enteroEnRango(crudo.confianza, 'confianza', 0, 100)
  if (!confianza.ok) errores.push(...confianza.errores)

  const razon = textoOpcional(crudo.razon, 'razon', LARGO_MAX.razon)
  if (!razon.ok) errores.push(...razon.errores)

  const esNuevo = crudo.esNuevo === true
  let candidatoId: string | null = null

  if (!esNuevo) {
    // Es cobertura de un hecho existente: el ID es obligatorio y debe estar
    // en el conjunto enviado.
    if (typeof crudo.candidatoId !== 'string' || crudo.candidatoId.trim() === '') {
      errores.push('candidatoId: obligatorio cuando esNuevo es false')
    } else {
      const id = crudo.candidatoId.trim()
      if (!idsCandidatos.includes(id)) {
        // No se incluye el ID recibido para no ensuciar logs con datos del modelo.
        errores.push('candidatoId: no pertenece al conjunto de candidatos enviado')
      } else {
        candidatoId = id
      }
    }
  } else if (crudo.candidatoId !== null && crudo.candidatoId !== undefined) {
    // esNuevo true con candidatoId es contradictorio: el modelo no se decidió.
    if (typeof crudo.candidatoId === 'string' && crudo.candidatoId.trim() !== '') {
      errores.push('candidatoId: no debe venir cuando esNuevo es true')
    }
  }

  if (errores.length > 0) return { ok: false, errores }

  return {
    ok: true,
    valor: {
      esNuevo,
      candidatoId,
      confianza: confianza.ok ? confianza.valor : 0,
      razon: (razon.ok ? razon.valor : null) ?? 'sin razón provista',
    },
  }
}

// ════════════════════════════════════════════
// PARSEO SEGURO DE JSON
// ════════════════════════════════════════════

/**
 * Extrae el JSON de una respuesta de chat, tolerando el fence de markdown que
 * algunos modelos agregan pese a las instrucciones.
 */
export function parsearJsonLLM(contenido: string): Validacion<unknown> {
  const limpio = contenido
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim()

  if (limpio.length === 0) return fallo('respuesta vacía')
  // Tope defensivo: una respuesta de 10 MB es un problema, no un dato.
  if (limpio.length > 200_000) return fallo('respuesta excede 200 KB')

  try {
    return { ok: true, valor: JSON.parse(limpio) }
  } catch (e) {
    return fallo(`JSON inválido: ${(e as Error).message.slice(0, 120)}`)
  }
}
