/**
 * Deduplicador inteligente de hechos delictivos.
 *
 * Cuando llega una noticia nueva, determina si es:
 * A) Un hecho delictivo NUEVO → crea HechoDelictivo + primera CoberturaMediatica
 * B) Cobertura de un hecho EXISTENTE → solo crea CoberturaMediatica vinculada
 *
 * La decisión se basa en:
 * 1. URL duplicada (ya procesada)
 * 2. Proximidad temporal (hechos en los últimos 30 días)
 * 3. Misma provincia + mismo tipo de delito
 * 4. Confirmación por IA cuando hay ambigüedad
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/mapa/queries'
import { crearClienteLLM } from '@/lib/mapa/cliente-llm'
import { parsearJsonLLM, validarDeduplicacion } from '@/lib/pipeline/schemas-llm'

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
// CONFIRMACIÓN POR IA
// ════════════════════════════════════════════

async function confirmarConIA(
  datos: DatosNoticia,
  candidatos: Awaited<ReturnType<typeof buscarHechosSimilares>>
): Promise<{ esNuevo: boolean; candidatoId: string | null; confianza: number; razon: string }> {

  if (candidatos.length === 0) {
    return {
      esNuevo: true,
      candidatoId: null,
      confianza: 95,
      razon: 'Sin candidatos similares en los últimos 30 días',
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

    const respuesta = await cliente.chat.completions.create({
      model: config.modelo,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    })

    const contenido = respuesta.choices[0]?.message?.content?.trim() || ''

    const parseado = parsearJsonLLM(contenido)
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

    return validado.valor

  } catch (error) {
    // Error del proveedor, distinto de una decisión negativa del modelo.
    console.error('Error en deduplicación IA:', error)
    return FALLBACK_DEDUP
  }
}

/**
 * Ante error del proveedor o respuesta inválida se asume hecho nuevo con
 * confianza baja: es preferible un duplicado, que el revisor humano puede
 * fusionar, a vincular la cobertura al hecho equivocado. La confianza baja
 * deja el caso marcado para revisión.
 */
const FALLBACK_DEDUP = {
  esNuevo: true,
  candidatoId: null,
  confianza: 30,
  razon: 'Respuesta de IA inválida o error del proveedor; asumido nuevo por precaución',
} as const

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

/**
 * Determina si una noticia es un hecho nuevo o cobertura de uno existente.
 *
 * Flujo:
 * 1. Verificar si la URL ya fue procesada → duplicado
 * 2. Buscar hechos similares (mismo tipo, provincia, últimos 30 días)
 * 3. Si no hay candidatos → es nuevo (sin consultar IA)
 * 4. Si hay candidatos → confirmar con IA
 */
export async function deduplicar(datos: DatosNoticia): Promise<ResultadoDeduplicacion> {

  // 1. Verificar URL duplicada
  const coberturaExistente = await prisma.coberturaMediatica.findUnique({
    where: { url: datos.url },
  })

  if (coberturaExistente) {
    return {
      esNuevo: false,
      hechoDelictivoId: coberturaExistente.hechoDelictivoId,
      confianza: 100,
      razon: 'URL ya procesada',
      urlDuplicada: true,
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
    }
  }

  // 4. Con candidatos → confirmar con IA
  const resultado = await confirmarConIA(datos, candidatos)
  return {
    esNuevo: resultado.esNuevo,
    hechoDelictivoId: resultado.candidatoId,
    confianza: resultado.confianza,
    razon: resultado.razon,
    urlDuplicada: false,
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