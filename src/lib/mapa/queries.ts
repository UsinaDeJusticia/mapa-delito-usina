import { PrismaClient, Prisma } from '@prisma/client'

// Singleton de Prisma para evitar múltiples conexiones en dev
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }
export const prisma = globalForPrisma.prisma || new PrismaClient()
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// ════════════════════════════════════════════
// TIPOS DE RESPUESTA
// ════════════════════════════════════════════

export interface ProvinciaEstadistica {
  provincia: string
  provinciaId: string
  latitud: number
  longitud: number
  totalHechos: number
  totalVictimas: number
  delitos: Array<{ nombre: string; hechos: number; victimas: number }>
}

export interface PuntoTendencia {
  anio: number
  hechos: number
  victimas: number
  variacionInteranual: number | null
}

// ════════════════════════════════════════════
// QUERIES
// ════════════════════════════════════════════

/**
 * Obtiene estadísticas agregadas por provincia para un año dado.
 * Usado por: /api/mapa/estadisticas → mapa coroplético
 */
export async function getEstadisticasPorProvincia(
  anio: number,
  tipoDelitoId?: string
): Promise<{ provincias: ProvinciaEstadistica[]; aniosDisponibles: number[] }> {

  const where: Prisma.HechoDelictivoWhereInput = {
    anio,
    esAgregado: true,
    ubicacion: {
      esCentroide: true,
      provincia: { not: 'Argentina' },
    },
  }

  if (tipoDelitoId) {
    where.tipoDelitoId = tipoDelitoId
  }

  const datos = await prisma.hechoDelictivo.findMany({
    where,
    include: {
      ubicacion: {
        select: { provincia: true, provinciaId: true, latitud: true, longitud: true }
      },
      tipoDelito: {
        select: { nombre: true, codigoSnic: true, categoria: true }
      },
    },
    orderBy: { cantidadHechos: 'desc' },
  })

  // Agrupar por provincia
  const porProvincia = new Map<string, ProvinciaEstadistica>()

  for (const dato of datos) {
    const key = dato.ubicacion.provincia
    const existing = porProvincia.get(key)

    const delitoInfo = {
      nombre: dato.tipoDelito.nombre,
      hechos: dato.cantidadHechos,
      victimas: dato.cantidadVictimas,
    }

    if (existing) {
      existing.totalHechos += dato.cantidadHechos
      existing.totalVictimas += dato.cantidadVictimas
      existing.delitos.push(delitoInfo)
    } else {
      porProvincia.set(key, {
        provincia: key,
        provinciaId: dato.ubicacion.provinciaId || '',
        latitud: Number(dato.ubicacion.latitud),
        longitud: Number(dato.ubicacion.longitud),
        totalHechos: dato.cantidadHechos,
        totalVictimas: dato.cantidadVictimas,
        delitos: [delitoInfo],
      })
    }
  }

  // Años disponibles
  const aniosRaw = await prisma.hechoDelictivo.findMany({
    where: { esAgregado: true },
    select: { anio: true },
    distinct: ['anio'],
    orderBy: { anio: 'asc' },
  })

  return {
    provincias: Array.from(porProvincia.values()),
    aniosDisponibles: aniosRaw.map(a => a.anio),
  }
}

/**
 * Obtiene la serie temporal de un tipo de delito para una provincia o el total nacional.
 * Usado por: /api/mapa/tendencias → gráfico de evolución
 */
export async function getTendencias(
  codigoSnic: number,
  provinciaId?: string
): Promise<{ tipoDelito: { nombre: string; codigoSnic: number; categoria: string }; serie: PuntoTendencia[] } | null> {

  const tipoDelito = await prisma.tipoDelito.findUnique({
    where: { codigoSnic },
  })

  if (!tipoDelito) return null

  const ubicacionWhere: Prisma.UbicacionWhereInput = { esCentroide: true }
  if (provinciaId) {
    ubicacionWhere.provinciaId = provinciaId
  } else {
    ubicacionWhere.provincia = 'Argentina'
  }

  const datos = await prisma.hechoDelictivo.findMany({
    where: {
      tipoDelitoId: tipoDelito.id,
      esAgregado: true,
      ubicacion: ubicacionWhere,
    },
    select: { anio: true, cantidadHechos: true, cantidadVictimas: true },
    orderBy: { anio: 'asc' },
  })

  const serie: PuntoTendencia[] = datos.map((d, i) => {
    const anterior = i > 0 ? datos[i - 1] : null
    const variacion = anterior && anterior.cantidadHechos > 0
      ? Math.round(((d.cantidadHechos - anterior.cantidadHechos) / anterior.cantidadHechos * 100) * 10) / 10
      : null

    return {
      anio: d.anio,
      hechos: d.cantidadHechos,
      victimas: d.cantidadVictimas,
      variacionInteranual: variacion,
    }
  })

  return {
    tipoDelito: {
      nombre: tipoDelito.nombre,
      codigoSnic: tipoDelito.codigoSnic,
      categoria: tipoDelito.categoria,
    },
    serie,
  }
}

/**
 * Obtiene todos los tipos de delito activos.
 * Usado por: /api/mapa/tipos-delito → selector de filtros
 */
export async function getTiposDelito() {
  return prisma.tipoDelito.findMany({
    where: { activo: true },
    orderBy: { codigoSnic: 'asc' },
    select: { id: true, codigoSnic: true, nombre: true, categoria: true },
  })
}

/**
 * Obtiene todas las provincias con ubicaciones.
 * Usado por: /api/mapa/provincias → lista de provincias para filtros
 */
export async function getProvincias() {
  return prisma.ubicacion.findMany({
    where: {
      esCentroide: true,
      provincia: { not: 'Argentina' },
    },
    select: { provincia: true, provinciaId: true, latitud: true, longitud: true },
    orderBy: { provincia: 'asc' },
  })
}