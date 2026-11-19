/**
 * Deduplicador inteligente de hechos delictivos.
 *
 * Cuando llega una noticia nueva, determina si es:
 * A) Un hecho delictivo NUEVO → crea HechoDelictivo + primera CoberturaMediatica
 * B) Cobertura de un hecho EXISTENTE → solo crea CoberturaMediatica vinculada
 *
 * La decisión es mayormente determinista; la IA solo interviene cuando queda
 * ambigüedad real:
 * 1. URL ya procesada → duplicado
 * 2. Candidatos: misma víctima (toda la historia) + misma provincia en una
 *    ventana de 60 días, con cualquier código SNIC del pipeline
 * 3. Sin candidatos → nuevo
 * 4. Mismo nombre de víctima (+ misma provincia, ventana de 90 días) →
 *    cobertura del hecho existente, sin consultar al modelo
 * 5. Ambiguo → confirmación por IA
 */

import { MAX_TOKENS_LLM } from '@/lib/pipeline/limites-llm'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/mapa/queries'
import { crearClienteLLM, parametrosExtraLLM } from '@/lib/mapa/cliente-llm'
import { parsearJsonLLM, validarDeduplicacion } from '@/lib/pipeline/schemas-llm'
import { obtenerContenidoLLM, formatearUso } from '@/lib/pipeline/llamada-llm'

// ════════════════════════════════════════════
// TIPOS
// ════════════════════════════════════════════

export interface DatosNoticia {
  tipoHecho: string
  codigoSnicEstimado: string
  ubicacion: {
    provincia: string | null
    ciudad: string | null
  }
  fecha: string | null
  titulo: string
  resumen: string | null
  medio: string
  medioTipo: 'provincial' | 'nacional'
  url: string
  nombreVictima?: string | null
}

export interface ResultadoDeduplicacion {
  esNuevo: boolean
  hechoDelictivoId: string | null
  confianza: number
  razon: string
  urlDuplicada: boolean
  /**
   * true cuando la decisión no es confiable (el proveedor de IA falló o
   * devolvió algo inválido) y el hecho necesita que una persona lo revise.
   * En todos los demás casos —URL duplicada, sin candidatos, coincidencia
   * determinista por nombre, o una respuesta de IA válida— la decisión es
   * confiable y esto es false.
   */
  requiereRevision: boolean
}

// ════════════════════════════════════════════
// BÚSQUEDA DE CANDIDATOS
// ════════════════════════════════════════════

/**
 * Códigos SNIC que registra el pipeline. La búsqueda de candidatos NO filtra
 * por el código de la noticia: el modelo puede clasificar la misma muerte como
 * homicidio doloso (1) en una nota y como "en investigación" (0) o culposo (4)
 * en otra. El 19/11/2026 las dos notas de Infobae sobre la muerte de Franco
 * Jara en una comisaría de San Juan entraron como dos hechos distintos.
 */
export const CODIGOS_CANDIDATOS = ['0', '1', '2', '3', '4'] as const

/**
 * Ventana de candidatos alrededor de la fecha de la noticia. 60 días hacia
 * atrás y no 30: las notas de seguimiento (imputaciones, detenciones,
 * autopsias) llegan semanas después del hecho. 7 hacia adelante por si la
 * nota trae una fecha anterior a la que se registró para el hecho.
 */
export const DIAS_CANDIDATOS_ATRAS = 60
export const DIAS_CANDIDATOS_ADELANTE = 7
const MAX_CANDIDATOS = 15

export function ventanaCandidatos(fecha: string | null | undefined, ahora: Date = new Date()): { desde: Date; hasta: Date } {
  const base = fecha ? new Date(fecha) : ahora
  const ref = Number.isNaN(base.getTime()) ? ahora : base
  const desde = new Date(ref.getTime() - DIAS_CANDIDATOS_ATRAS * 86_400_000)
  const hasta = new Date(Math.min(ref.getTime() + DIAS_CANDIDATOS_ADELANTE * 86_400_000, ahora.getTime() + 86_400_000))
  return { desde, hasta }
}

/** Une dos listas de candidatos sin repetir, respetando el orden (primero los por nombre). */
export function combinarCandidatos<T extends { id: string }>(primero: T[], despues: T[], max = MAX_CANDIDATOS): T[] {
  const vistos = new Set<string>()
  const salida: T[] = []
  for (const c of [...primero, ...despues]) {
    if (vistos.has(c.id)) continue
    vistos.add(c.id)
    salida.push(c)
    if (salida.length >= max) break
  }
  return salida
}

/**
 * Partes de un nombre para prefiltrar en SQL: alcanza con que coincida
 * cualquiera. Adivinar cuál es el apellido falla ("Nicolás Salerno": las dos
 * partes miden lo mismo; "Franco Jara Pérez" vs. "Franco Jara"), así que el
 * filtro fino lo hace mismoNombreVictima() en memoria. null si el nombre no
 * alcanza para identificar a alguien (menos de dos partes, o una descripción).
 */
export function tokensParaBuscarNombre(nombre: string | null | undefined): string[] | null {
  if (!nombre) return null
  const tokens = tokensNombre(nombre)
  return tokens.length >= 2 ? tokens : null
}

const INCLUDE_CANDIDATO = {
  ubicacion: { select: { provincia: true, departamento: true } },
  tipoDelito: { select: { nombre: true } },
  coberturas: {
    select: { titulo: true, medio: true, url: true, resumen: true },
    orderBy: { fechaPublicacion: 'desc' as const },
    take: 5,
  },
} satisfies Prisma.HechoDelictivoInclude

type Candidato = Prisma.HechoDelictivoGetPayload<{ include: typeof INCLUDE_CANDIDATO }>

async function buscarHechosSimilares(datos: DatosNoticia): Promise<Candidato[]> {
  // A) Misma víctima, en toda la historia: prefiltro en SQL por cualquier parte del
  //    nombre y comparación fina en memoria. Antes se buscaba el nombre completo con
  //    ILIKE, y "Franco Jara" no encontraba a "Franco Nicolás Jara".
  let porNombre: Candidato[] = []
  const tokens = tokensParaBuscarNombre(datos.nombreVictima)
  if (tokens) {
    const patrones = tokens.map(t => `%${t}%`)
    const filas = await prisma.$queryRaw<Array<{ id: string; nombre_victima: string | null }>>`
      SELECT id::text, nombre_victima FROM hechos_delictivos
      WHERE es_agregado = false
        -- Sin acentos, igual que los tokens: 'nicolas' tiene que encontrar 'Nicolás'.
        AND translate(lower(nombre_victima), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc')
            ILIKE ANY(${patrones}::text[])
      ORDER BY fecha_hecho DESC
      LIMIT 200
    `
    const ids = filas.filter(f => mismoNombreVictima(datos.nombreVictima, f.nombre_victima)).map(f => f.id)
    if (ids.length > 0) {
      porNombre = await prisma.hechoDelictivo.findMany({
        where: { id: { in: ids } },
        include: INCLUDE_CANDIDATO,
        orderBy: { fechaHecho: 'desc' },
        take: 10,
      })
    }
  }

  // B) Cercanía: misma provincia, ventana de fechas, CUALQUIER código del
  //    pipeline. Se busca siempre, no solo cuando no hubo nombre: la nota
  //    nueva puede no nombrar a la víctima que el hecho registrado sí tiene.
  const { desde, hasta } = ventanaCandidatos(datos.fecha)
  const where: Prisma.HechoDelictivoWhereInput = {
    esAgregado: false,
    tipoDelito: { codigoSnic: { in: [...CODIGOS_CANDIDATOS] } },
    fechaHecho: { gte: desde, lte: hasta },
  }
  if (datos.ubicacion.provincia) {
    where.ubicacion = { provincia: { contains: datos.ubicacion.provincia, mode: 'insensitive' } }
  }
  const porCercania = await prisma.hechoDelictivo.findMany({
    where,
    include: INCLUDE_CANDIDATO,
    orderBy: { fechaHecho: 'desc' },
    take: MAX_CANDIDATOS,
  })

  return combinarCandidatos(porNombre, porCercania)
}

// ════════════════════════════════════════════
// COINCIDENCIA DETERMINISTA POR NOMBRE
// ════════════════════════════════════════════

/** Quita acentos, puntuación y mayúsculas para poder comparar nombres. */
function normalizarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'el', 'da', 'do', 'van', 'di'])

/**
 * Palabras que aparecen en `nombre_victima` cuando el modelo pone una
 * DESCRIPCIÓN en lugar de un nombre: "un joven", "una mujer de 35 años",
 * "No identificado", "menor de edad". Sin este filtro "un joven" y "un joven
 * de 17 años" eran "la misma persona" (dos tokens, todos contenidos) y la
 * nota de un homicidio nuevo se vinculaba a otro con confianza 97, sin pasar
 * por la IA ni por revisión: el caso desaparecía del mapa.
 */
const PALABRAS_GENERICAS = new Set([
  'un', 'una', 'uno', 'unos', 'unas', 'joven', 'jovenes', 'hombre', 'hombres', 'mujer', 'mujeres',
  'menor', 'menores', 'nene', 'nena', 'nino', 'nina', 'bebe', 'beba', 'adolescente', 'anciano',
  'anciana', 'abuelo', 'abuela', 'senor', 'senora', 'sujeto', 'persona', 'personas', 'victima',
  'victimas', 'desconocido', 'desconocida', 'identificado', 'identificada', 'identificar', 'no',
  'sin', 'nn', 'masculino', 'femenino', 'anos', 'ano', 'meses', 'edad', 'policia', 'efectivo',
  'agente', 'delincuente', 'vecino', 'vecina', 'trabajador', 'trabajadora', 'conductor',
  'motociclista', 'peaton', 'chofer', 'taxista', 'remisero', 'comerciante', 'jubilado', 'jubilada',
  'hijo', 'hija', 'padre', 'madre', 'pareja', 'expareja', 'esposa', 'esposo', 'novio', 'novia',
  'hermano', 'hermana', 'reservado', 'reservada', 'dato', 'datos', 'trascendio',
])

function tokensNombre(nombre: string): string[] {
  return normalizarNombre(nombre)
    .split(' ')
    .filter(t => t.length >= 2 && !PARTICULAS.has(t) && !PALABRAS_GENERICAS.has(t) && !/\d/.test(t))
}

/**
 * ¿Son la misma persona?
 *
 * Se exige que el nombre más corto tenga al menos dos tokens (nombre +
 * apellido) y que todos estén contenidos en el otro. Así "Juan Pérez" matchea
 * con "Juan Carlos Pérez González" —los medios publican el nombre con
 * distinto grado de completitud— pero "Juan" no matchea con nada, porque un
 * solo token es demasiado genérico.
 */
export function mismoNombreVictima(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const ta = tokensNombre(a)
  const tb = tokensNombre(b)
  if (ta.length < 2 || tb.length < 2) return false

  const [corto, largo] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const setLargo = new Set(largo)
  return corto.every(t => setLargo.has(t))
}

/** Ventana para aceptar una coincidencia de nombre sin consultar al modelo. */
const DIAS_VENTANA_NOMBRE = 90

function mismaProvincia(a: string | null | undefined, b: string | null | undefined): boolean {
  // Si alguna es desconocida no se contradicen: no bloquea la coincidencia.
  if (!a || !b) return true
  const na = normalizarNombre(a)
  const nb = normalizarNombre(b)
  return na.includes(nb) || nb.includes(na)
}

/**
 * Busca una coincidencia inequívoca ANTES de gastar una llamada al modelo.
 *
 * Dos homicidios distintos con el mismo nombre y apellido, en la misma
 * provincia y dentro de 90 días es prácticamente imposible. Resolverlo acá
 * ahorra tokens y —lo más importante— hace que el caso más común de duplicado
 * no dependa de que el proveedor de LLM esté disponible.
 */
function coincidenciaPorNombre(
  datos: DatosNoticia,
  candidatos: Candidato[],
): { id: string; nombre: string } | null {
  if (!datos.nombreVictima) return null

  const fechaNoticia = datos.fecha ? new Date(datos.fecha) : new Date()
  if (Number.isNaN(fechaNoticia.getTime())) return null

  for (const c of candidatos) {
    if (!mismoNombreVictima(datos.nombreVictima, c.nombreVictima)) continue
    if (!mismaProvincia(datos.ubicacion.provincia, c.ubicacion.provincia)) continue

    const dias = Math.abs(fechaNoticia.getTime() - c.fechaHecho.getTime()) / 86_400_000
    if (dias > DIAS_VENTANA_NOMBRE) continue

    return { id: c.id, nombre: c.nombreVictima ?? datos.nombreVictima }
  }
  return null
}

// ════════════════════════════════════════════
// CONFIRMACIÓN POR IA
// ════════════════════════════════════════════

/** Recorta textos de terceros para el prompt sin cortar a mitad de palabra. */
function recortar(texto: string | null | undefined, max: number): string {
  if (!texto) return ''
  const limpio = texto.replace(/\s+/g, ' ').trim()
  if (limpio.length <= max) return limpio
  return limpio.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

type CandidatoPrompt = Pick<Candidato, 'id' | 'fechaHecho' | 'nombreVictima'> & {
  tipoDelito: { nombre: string }
  ubicacion: { provincia: string; departamento: string | null }
  coberturas: Array<{ titulo: string | null; medio: string; resumen: string | null }>
}

/**
 * Prompt de deduplicación. Antes el modelo veía solo títulos y fechas: "muerte
 * de un joven en una comisaría de San Juan" e "Imputaron… Franco Jara" no se
 * parecían en nada. Ahora ve víctima, localidad y resumen de los dos lados, y
 * la regla explícita de que una nota de seguimiento no es un crimen nuevo.
 */
export function construirPromptDeduplicacion(datos: DatosNoticia, candidatos: CandidatoPrompt[]): string {
  const candidatosTexto = candidatos.map((c, i) => {
    const coberturas = c.coberturas
      .map(cob => `  - ${cob.medio}: "${recortar(cob.titulo, 160)}"${cob.resumen ? `\n    Resumen: ${recortar(cob.resumen, 400)}` : ''}`)
      .join('\n')
    return `CANDIDATO ${i + 1}:
  ID: ${c.id}
  Tipo: ${c.tipoDelito.nombre}
  Fecha del hecho: ${c.fechaHecho.toISOString().split('T')[0]}
  Víctima: ${c.nombreVictima || 'sin nombre registrado'}
  Ubicación: ${c.ubicacion.provincia}${c.ubicacion.departamento ? ', ' + c.ubicacion.departamento : ''}
  Coberturas existentes:
${coberturas || '  (ninguna aún)'}`
  }).join('\n\n')

  return `Sos un analista que determina si una noticia policial refiere a un crimen ya registrado o es un crimen nuevo.

NOTICIA NUEVA:
  Título: "${recortar(datos.titulo, 200)}"
  Tipo: ${datos.tipoHecho}
  Fecha del hecho: ${datos.fecha || 'no especificada'}
  Víctima: ${datos.nombreVictima || 'no nombrada en la nota'}
  Ubicación: ${datos.ubicacion.provincia || 'desconocida'}${datos.ubicacion.ciudad ? ', ' + datos.ubicacion.ciudad : ''}
  Medio: ${datos.medio}
  Resumen: ${recortar(datos.resumen, 600) || '(sin resumen)'}

HECHOS YA REGISTRADOS:
${candidatosTexto}

CRITERIOS:
- Las notas de seguimiento sobre el mismo crimen (imputaciones, detenciones, autopsias, marchas, juicios, sentencias) son COBERTURA del hecho existente, no un crimen nuevo.
- Si la nota no nombra a la víctima pero coinciden el lugar, la fecha aproximada y las circunstancias (por ejemplo, la misma comisaría, la misma dinámica, la misma cantidad de imputados), es el mismo hecho.
- La clasificación (doloso, culposo, en investigación) puede diferir entre notas del mismo hecho: no la uses para separarlos.
- Si hay víctimas distintas con nombre, son hechos distintos aunque el lugar coincida.

¿La noticia nueva es cobertura de alguno de los candidatos, o es un crimen diferente?

Respondé SOLO con JSON, sin texto adicional:
{"esNuevo": true, "candidatoId": null, "confianza": 90, "razon": "explicación breve"}
o
{"esNuevo": false, "candidatoId": "ID-del-candidato", "confianza": 85, "razon": "explicación breve"}`
}

interface ResultadoConfirmacionIA {
  esNuevo: boolean
  candidatoId: string | null
  confianza: number
  razon: string
  requiereRevision: boolean
}

async function confirmarConIA(
  datos: DatosNoticia,
  candidatos: Candidato[]
): Promise<ResultadoConfirmacionIA> {

  if (candidatos.length === 0) {
    return {
      esNuevo: true,
      candidatoId: null,
      confianza: 95,
      razon: 'Sin candidatos similares',
      requiereRevision: false,
    }
  }

  const prompt = construirPromptDeduplicacion(datos, candidatos)

  try {
    const { cliente, config } = crearClienteLLM('Mapa del Delito - Deduplicador')

    const resultado = await obtenerContenidoLLM({
      etiqueta: 'deduplicación',
      aceptar: contenido => parsearJsonLLM(contenido).ok,
      registrarUso: d => {
        const linea = formatearUso(d, 'deduplicación')
        if (linea) console.log(linea)
      },
      ejecutar: () => cliente.chat.completions.create({
        model: config.modelo,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        // Holgado (ver limites-llm.ts): un corte acá no es cosmético — el
        // fallback asume "es un hecho nuevo", así que duplica el caso en el mapa.
        max_tokens: MAX_TOKENS_LLM.deduplicacion,
        ...(parametrosExtraLLM(config) as object),
      }),
    })

    if (!resultado.ok) {
      // FALLBACK_DEDUP asume "es nuevo" y marca requiereRevision: ante la duda,
      // que lo mire una persona en vez de vincular o descartar a ciegas.
      console.error(
        `⚠️ Deduplicación sin respuesta usable tras ${resultado.intentos} intentos (${resultado.motivo})`
      )
      return FALLBACK_DEDUP
    }

    const parseado = parsearJsonLLM(resultado.contenido)
    if (!parseado.ok) {
      console.error(`⚠️ Deduplicación: respuesta no parseable — ${parseado.errores.join('; ')}`)
      return FALLBACK_DEDUP
    }

    // La verificación clave: candidatoId tiene que pertenecer al conjunto que
    // efectivamente se le mandó al modelo. Sin esto, un ID alucinado o inducido
    // por el contenido de la noticia podía vincular esta cobertura a cualquier
    // hecho de la base.
    const idsEnviados = candidatos.map(c => c.id)
    const validado = validarDeduplicacion(parseado.valor, idsEnviados)

    if (!validado.ok) {
      console.error(`⚠️ Deduplicación: respuesta inválida — ${validado.errores.join('; ')}`)
      return FALLBACK_DEDUP
    }

    // Una respuesta válida del modelo es una decisión confiable: no necesita
    // revisión por el solo hecho de haber pasado por la IA.
    return { ...validado.valor, requiereRevision: false }

  } catch (error) {
    // Error del proveedor, distinto de una decisión negativa del modelo.
    console.error('Error en deduplicación IA:', error)
    return FALLBACK_DEDUP
  }
}

/**
 * Ante error del proveedor o respuesta inválida se asume hecho nuevo con
 * confianza baja: es preferible un duplicado, que el revisor humano puede
 * fusionar, a vincular la cobertura al hecho equivocado.
 *
 * `requiereRevision: true` es la parte que antes faltaba. El comentario
 * original decía que "la confianza baja deja el caso marcado para revisión",
 * pero nada lo hacía: el hecho se creaba con `requiereRevision` solo desde la
 * confianza de EXTRACCIÓN, nunca desde esta. Con un solo proveedor de LLM (ver
 * docs/llm/DECISIONS.md), una caída de una hora insertaba un duplicado por
 * cada noticia, sin ninguna marca visible en /admin/revisiones.
 */
// Exportado solo para que el test pueda fijar el contrato exacto sin tener
// que mockear Prisma ni el cliente LLM para llegar hasta acá.
export const FALLBACK_DEDUP: ResultadoConfirmacionIA = {
  esNuevo: true,
  candidatoId: null,
  confianza: 30,
  razon: 'Respuesta de IA inválida o error del proveedor; asumido nuevo por precaución',
  requiereRevision: true,
}

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

/**
 * Determina si una noticia es un hecho nuevo o cobertura de uno existente.
 *
 * Flujo:
 * 1. Verificar si la URL ya fue procesada → duplicado
 * 2. Buscar hechos similares: misma víctima en toda la historia + misma
 *    provincia en 60 días, sin filtrar por código SNIC
 * 3. Sin candidatos → es nuevo (sin consultar IA)
 * 4. Mismo nombre de víctima (+ misma provincia, ventana de 90 días) →
 *    cobertura del hecho existente (sin consultar IA)
 * 5. Ambiguo → confirmar con IA
 */
/**
 * Única consulta de "¿esta URL ya está en la base?", compartida por
 * `deduplicar()` y por el scraper.
 *
 * Existe como función separada (no inline en deduplicar) porque el scraper
 * necesita el mismo chequeo ANTES de gastar la extracción con el LLM: en
 * producción el 44% de las llamadas de extracción (32 de 72 en la corrida del
 * 22/8) terminaban descartadas por "URL ya procesada" — se pagaban y se
 * tiraban porque el chequeo vivía únicamente acá, después de extraer. Si cada
 * lado escribiera su propio `findUnique`, podrían divergir con el tiempo;
 * exportar una sola función evita esa deriva.
 */
async function buscarCoberturaPorUrl(url: string) {
  return prisma.coberturaMediatica.findUnique({ where: { url } })
}

/**
 * true si la URL ya tiene una cobertura registrada.
 *
 * Pensada para el scraper: se llama apenas se conoce la URL final del
 * artículo (tras el click y la validación de destino), y ANTES de extraer
 * texto o llamar al LLM de extracción. `deduplicar()` sigue haciendo su
 * propio chequeo — es idempotente y es quien protege el camino que no pasa
 * por el scraper (p.ej. una re-ejecución manual de deduplicación).
 */
export async function urlYaRegistrada(url: string): Promise<boolean> {
  const cobertura = await buscarCoberturaPorUrl(url)
  return cobertura !== null
}

export async function deduplicar(datos: DatosNoticia): Promise<ResultadoDeduplicacion> {

  // 1. Verificar URL duplicada
  const coberturaExistente = await buscarCoberturaPorUrl(datos.url)

  if (coberturaExistente) {
    return {
      esNuevo: false,
      hechoDelictivoId: coberturaExistente.hechoDelictivoId,
      confianza: 100,
      razon: 'URL ya procesada',
      urlDuplicada: true,
      requiereRevision: false,
    }
  }

  // 2. Buscar candidatos similares
  const candidatos = await buscarHechosSimilares(datos)

  // 3. Sin candidatos → nuevo
  if (candidatos.length === 0) {
    return {
      esNuevo: true,
      hechoDelictivoId: null,
      confianza: 95,
      razon: `Sin hechos similares (misma víctima o misma provincia en ${DIAS_CANDIDATOS_ATRAS} días)`,
      urlDuplicada: false,
      requiereRevision: false,
    }
  }

  // 4. Coincidencia inequívoca por nombre de víctima → vincular sin IA.
  //    Es el caso más común de duplicado y no tiene sentido gastar una
  //    llamada al modelo ni depender de su disponibilidad para resolverlo.
  const porNombre = coincidenciaPorNombre(datos, candidatos)
  if (porNombre) {
    return {
      esNuevo: false,
      hechoDelictivoId: porNombre.id,
      confianza: 97,
      razon: `Misma víctima ya registrada (${porNombre.nombre})`,
      urlDuplicada: false,
      requiereRevision: false,
    }
  }

  // 5. Ambiguo → confirmar con IA
  const resultado = await confirmarConIA(datos, candidatos)
  return {
    esNuevo: resultado.esNuevo,
    hechoDelictivoId: resultado.candidatoId,
    confianza: resultado.confianza,
    razon: resultado.razon,
    urlDuplicada: false,
    requiereRevision: resultado.requiereRevision,
  }
}

// ════════════════════════════════════════════
// CLASIFICADOR DE COBERTURA
// ════════════════════════════════════════════

/**
 * Clasifica el tipo de cobertura de una noticia.
 * Se llama DESPUÉS de determinar que es cobertura de un hecho existente.
 */
export function clasificarCobertura(titulo: string, texto: string): string {
  const contenido = (titulo + ' ' + texto).toLowerCase()

  if (/detenid|detenci[oó]n|apres[oó]|captur|arrestar/.test(contenido)) return 'DETENCION'
  if (/march[aó]|reclam|pidi[oó] justicia|familiares|movilizaci/.test(contenido)) return 'MARCHA_RECLAMO'
  if (/juicio|tribunal|fiscal[ií]a|imput|acusad|elevad|audiencia/.test(contenido)) return 'PROCESO_JUDICIAL'
  if (/conden[aó]|absuelto|sentencia|veredicto|pena de|culpable/.test(contenido)) return 'SENTENCIA'
  if (/aniversario|a \d+ año|homenaje|recordar|conmemor/.test(contenido)) return 'ANIVERSARIO'
  if (/opini[oó]n|editorial|columna|an[aá]lisis|reflexi/.test(contenido)) return 'OPINION_EDITORIAL'
  if (/nuevo[s]? dato|investig|autopsia|peri[tc]ia|evidencia/.test(contenido)) return 'ACTUALIZACION'

  return 'ACTUALIZACION'
}