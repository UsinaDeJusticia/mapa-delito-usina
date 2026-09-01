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
 * 2. Proximidad temporal (hechos en los últimos 30 días) o nombre de víctima
 * 3. Sin candidatos → nuevo
 * 4. Mismo nombre de víctima (+ misma provincia, ventana de 90 días) →
 *    cobertura del hecho existente, sin consultar al modelo
 * 5. Ambiguo → confirmación por IA
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/mapa/queries'
import { crearClienteLLM } from '@/lib/mapa/cliente-llm'
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

async function buscarHechosSimilares(datos: DatosNoticia) {
  const include = {
    ubicacion: { select: { provincia: true, departamento: true } },
    tipoDelito: { select: { nombre: true } },
    coberturas: {
      select: { titulo: true, medio: true, url: true },
      orderBy: { fechaPublicacion: 'desc' as const },
      take: 5,
    },
  }

  // Si hay nombre de víctima conocido, buscar por nombre en toda la historia
  if (datos.nombreVictima) {
    const idsConNombre = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM hechos_delictivos
      WHERE es_agregado = false
        AND nombre_victima ILIKE ${'%' + datos.nombreVictima + '%'}
      ORDER BY fecha_hecho DESC
      LIMIT 10
    `
    if (idsConNombre.length > 0) {
      return prisma.hechoDelictivo.findMany({
        where: { id: { in: idsConNombre.map(r => r.id) } },
        include,
        orderBy: { fechaHecho: 'desc' },
        take: 10,
      })
    }
  }

  // Búsqueda por tipo + provincia + ventana 30 días
  const fechaNoticia = datos.fecha ? new Date(datos.fecha) : new Date()
  const hace30Dias = new Date(fechaNoticia)
  hace30Dias.setDate(hace30Dias.getDate() - 30)

  const where: Prisma.HechoDelictivoWhereInput = {
    esAgregado: false,
    tipoDelito: {
      codigoSnic: datos.codigoSnicEstimado,
    },
    fechaHecho: {
      gte: hace30Dias,
      lte: new Date(),
    },
  }

  if (datos.ubicacion.provincia) {
    where.ubicacion = {
      provincia: {
        contains: datos.ubicacion.provincia,
        mode: 'insensitive',
      },
    }
  }

  return prisma.hechoDelictivo.findMany({
    where,
    include,
    orderBy: { fechaHecho: 'desc' },
    take: 10,
  })
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

function tokensNombre(nombre: string): string[] {
  return normalizarNombre(nombre)
    .split(' ')
    .filter(t => t.length >= 2 && !PARTICULAS.has(t))
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
  candidatos: Awaited<ReturnType<typeof buscarHechosSimilares>>,
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

interface ResultadoConfirmacionIA {
  esNuevo: boolean
  candidatoId: string | null
  confianza: number
  razon: string
  requiereRevision: boolean
}

async function confirmarConIA(
  datos: DatosNoticia,
  candidatos: Awaited<ReturnType<typeof buscarHechosSimilares>>
): Promise<ResultadoConfirmacionIA> {

  if (candidatos.length === 0) {
    return {
      esNuevo: true,
      candidatoId: null,
      confianza: 95,
      razon: 'Sin candidatos similares en los últimos 30 días',
      requiereRevision: false,
    }
  }

  const candidatosTexto = candidatos.map((c, i) => {
    const coberturas = c.coberturas.map(cob => `  - ${cob.medio}: "${cob.titulo}"`).join('\n')
    return `CANDIDATO ${i + 1}:
  ID: ${c.id}
  Tipo: ${c.tipoDelito.nombre}
  Fecha: ${c.fechaHecho.toISOString().split('T')[0]}
  Ubicación: ${c.ubicacion.provincia}${c.ubicacion.departamento ? ', ' + c.ubicacion.departamento : ''}
  Coberturas existentes:
${coberturas || '  (ninguna aún)'}`
  }).join('\n\n')

  const prompt = `Sos un analista que determina si una noticia policial refiere a un crimen ya registrado o es un crimen nuevo.

NOTICIA NUEVA:
  Título: "${datos.titulo}"
  Tipo: ${datos.tipoHecho}
  Fecha: ${datos.fecha || 'no especificada'}
  Ubicación: ${datos.ubicacion.provincia || 'desconocida'}${datos.ubicacion.ciudad ? ', ' + datos.ubicacion.ciudad : ''}
  Medio: ${datos.medio}

HECHOS YA REGISTRADOS:
${candidatosTexto}

¿La noticia nueva es cobertura de alguno de los candidatos, o es un crimen diferente?

Respondé SOLO con JSON, sin texto adicional:
{"esNuevo": true, "candidatoId": null, "confianza": 90, "razon": "explicación breve"}
o
{"esNuevo": false, "candidatoId": "ID-del-candidato", "confianza": 85, "razon": "explicación breve"}`

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
        // 600 y no 300: la salida es JSON con un campo `razon` en prosa, y 300
        // dejaba el corte al alcance de una explicación un poco larga. Un corte
        // acá no es cosmético — el fallback asume "es un hecho nuevo", así que
        // duplica el caso en el mapa.
        max_tokens: 600,
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
 * 2. Buscar hechos similares (mismo tipo, provincia, últimos 30 días, o
 *    nombre de víctima en toda la historia)
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
      razon: 'Sin hechos similares en los últimos 30 días',
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