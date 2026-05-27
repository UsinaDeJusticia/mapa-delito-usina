import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }
export const prisma = globalForPrisma.prisma || new PrismaClient()
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// ════════════════════════════════════════════
// TIPOS
// ════════════════════════════════════════════

export type FuenteDatos = 'snic' | 'sat'

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
// CENTROIDES PROVINCIALES
// ════════════════════════════════════════════

const PROVINCIAS_CENTROIDES: Record<string, { latitud: number; longitud: number; nombre: string }> = {
  '02': { latitud: -34.6037, longitud: -58.3816, nombre: 'CABA' },
  '06': { latitud: -34.9215, longitud: -57.9545, nombre: 'Buenos Aires' },
  '10': { latitud: -28.4696, longitud: -65.7852, nombre: 'Catamarca' },
  '14': { latitud: -31.4201, longitud: -64.1888, nombre: 'Córdoba' },
  '18': { latitud: -28.4696, longitud: -57.9862, nombre: 'Corrientes' },
  '22': { latitud: -26.3864, longitud: -60.7658, nombre: 'Chaco' },
  '26': { latitud: -43.3000, longitud: -65.1000, nombre: 'Chubut' },
  '30': { latitud: -31.7413, longitud: -60.1556, nombre: 'Entre Ríos' },
  '34': { latitud: -26.1775, longitud: -58.1781, nombre: 'Formosa' },
  '38': { latitud: -24.1858, longitud: -65.2995, nombre: 'Jujuy' },
  '42': { latitud: -36.6167, longitud: -64.2833, nombre: 'La Pampa' },
  '46': { latitud: -29.4131, longitud: -66.8559, nombre: 'La Rioja' },
  '50': { latitud: -34.6299, longitud: -68.3280, nombre: 'Mendoza' },
  '54': { latitud: -27.3621, longitud: -55.9008, nombre: 'Misiones' },
  '58': { latitud: -38.9516, longitud: -68.0591, nombre: 'Neuquén' },
  '62': { latitud: -40.8135, longitud: -63.0000, nombre: 'Río Negro' },
  '66': { latitud: -24.7821, longitud: -65.4232, nombre: 'Salta' },
  '70': { latitud: -31.5375, longitud: -68.5364, nombre: 'San Juan' },
  '74': { latitud: -33.2962, longitud: -66.3280, nombre: 'San Luis' },
  '78': { latitud: -48.8154, longitud: -69.9557, nombre: 'Santa Cruz' },
  '82': { latitud: -31.6107, longitud: -60.6973, nombre: 'Santa Fe' },
  '86': { latitud: -27.7824, longitud: -64.2642, nombre: 'Santiago del Estero' },
  '90': { latitud: -26.8083, longitud: -65.2176, nombre: 'Tucumán' },
  '94': { latitud: -54.8019, longitud: -68.3030, nombre: 'Tierra del Fuego' },
}

// ════════════════════════════════════════════
// QUERY SNIC (materialized view → ~600 filas)
// ════════════════════════════════════════════

async function getEstadisticasSNIC(
  anio: number,
  tipoDelitoId?: string
): Promise<{ provincias: ProvinciaEstadistica[]; aniosDisponibles: number[] }> {

  let rows: Array<{
    provincia_id: string
    provincia_nombre: string
    total_hechos: number
    total_victimas: number
    tipo_delito_nombre?: string
  }>

  if (tipoDelitoId) {
    // Con filtro de delito → vista con desglose
    rows = await prisma.$queryRaw`
      SELECT provincia_id, provincia_nombre,
             total_hechos, total_victimas,
             tipo_delito_nombre
      FROM mv_snic_provincia_delito
      WHERE anio = ${anio} AND tipo_delito_id = ${tipoDelitoId}
      ORDER BY provincia_nombre
    `
  } else {
    // Sin filtro → vista agregada (más rápida)
    rows = await prisma.$queryRaw`
      SELECT provincia_id, provincia_nombre,
             total_hechos, total_victimas
      FROM mv_snic_provincia
      WHERE anio = ${anio}
      ORDER BY provincia_nombre
    `
  }

  // Agrupar por provincia (necesario si hay filtro por delito con múltiples tipos)
  const porProvincia = new Map<string, ProvinciaEstadistica>()

  for (const row of rows) {
    const centroide = PROVINCIAS_CENTROIDES[row.provincia_id]
    if (!centroide) continue

    const existing = porProvincia.get(row.provincia_id)
    const delitoInfo = {
      nombre: row.tipo_delito_nombre || 'Todos los delitos',
      hechos: Number(row.total_hechos),
      victimas: Number(row.total_victimas),
    }

    if (existing) {
      existing.totalHechos += delitoInfo.hechos
      existing.totalVictimas += delitoInfo.victimas
      if (row.tipo_delito_nombre) {
        existing.delitos.push(delitoInfo)
      }
    } else {
      porProvincia.set(row.provincia_id, {
        provincia: row.provincia_nombre || centroide.nombre,
        provinciaId: row.provincia_id,
        latitud: centroide.latitud,
        longitud: centroide.longitud,
        totalHechos: delitoInfo.hechos,
        totalVictimas: delitoInfo.victimas,
        delitos: row.tipo_delito_nombre ? [delitoInfo] : [],
      })
    }
  }

  // Años disponibles (desde materialized view)
  const aniosRaw: Array<{ anio: number }> = await prisma.$queryRaw`
    SELECT anio FROM mv_anios_disponibles
    WHERE fuente = 'snic'
    ORDER BY anio
  `

  return {
    provincias: Array.from(porProvincia.values()),
    aniosDisponibles: aniosRaw.map(a => Number(a.anio)),
  }
}

// ════════════════════════════════════════════
// QUERY SAT (materialized view → ~200 filas)
// ════════════════════════════════════════════

async function getEstadisticasSAT(
  anio: number
): Promise<{ provincias: ProvinciaEstadistica[]; aniosDisponibles: number[] }> {

  const rows: Array<{
    provincia_id: string
    provincia_nombre: string
    total_hechos: number
    total_victimas: number
    femicidios: number
  }> = await prisma.$queryRaw`
    SELECT provincia_id, provincia_nombre,
           total_hechos, total_victimas, femicidios
    FROM mv_sat_provincia
    WHERE anio = ${anio}
    ORDER BY provincia_nombre
  `

  const provincias: ProvinciaEstadistica[] = rows
    .filter(row => {
      const padded = row.provincia_id.padStart(2, '0')
      return PROVINCIAS_CENTROIDES[padded]
    })
    .map(row => {
      const paddedId = row.provincia_id.padStart(2, '0')
      const centroide = PROVINCIAS_CENTROIDES[paddedId]
      return {
        provincia: row.provincia_nombre || centroide.nombre,
        provinciaId: paddedId,
        latitud: centroide.latitud,
        longitud: centroide.longitud,
        totalHechos: Number(row.total_hechos),
        totalVictimas: Number(row.total_victimas),
        delitos: [{
          nombre: 'Homicidios dolosos',
          hechos: Number(row.total_hechos),
          victimas: Number(row.total_victimas),
        }],
      }
    })

  // Años disponibles
  const aniosRaw: Array<{ anio: number }> = await prisma.$queryRaw`
    SELECT anio FROM mv_anios_disponibles
    WHERE fuente = 'sat'
    ORDER BY anio
  `

  return {
    provincias,
    aniosDisponibles: aniosRaw.map(a => Number(a.anio)),
  }
}

// ════════════════════════════════════════════
// QUERY SAT FILTRADO (directo a hechos_delictivos)
// ════════════════════════════════════════════

export interface FiltrosSAT {
  sexo?: string
  arma?: string
  vinculo?: string
  lugar?: string
}

export async function getEstadisticasSATFiltrado(
  anio: number,
  filtros: FiltrosSAT
): Promise<{ provincias: ProvinciaEstadistica[]; aniosDisponibles: number[] }> {
  const condiciones: string[] = [
    'hd.es_agregado = false',
    `hd.anio = ${anio}`,
  ]
  const params: unknown[] = []
  let paramIndex = 1

  if (filtros.sexo) {
    condiciones.push(`hd."victimaSexo" = $${paramIndex}`)
    params.push(filtros.sexo)
    paramIndex++
  }
  if (filtros.arma) {
    condiciones.push(`hd."medioComision" = $${paramIndex}`)
    params.push(filtros.arma)
    paramIndex++
  }
  if (filtros.vinculo) {
    condiciones.push(`hd."vinculoVictimaVictimario" = $${paramIndex}`)
    params.push(filtros.vinculo)
    paramIndex++
  }
  if (filtros.lugar) {
    condiciones.push(`hd."lugarHecho" = $${paramIndex}`)
    params.push(filtros.lugar)
    paramIndex++
  }

  const whereClause = condiciones.join(' AND ')

  const sql = `
    SELECT
      u.provincia_id,
      u.provincia AS provincia_nombre,
      COUNT(*)::int AS total_hechos,
      SUM(hd.cantidad_victimas)::int AS total_victimas
    FROM hechos_delictivos hd
    JOIN ubicaciones u ON hd.ubicacion_id = u.id
    WHERE ${whereClause}
      AND u.provincia IS NOT NULL
    GROUP BY u.provincia_id, u.provincia
    ORDER BY u.provincia
  `

  const rows: Array<{
    provincia_id: string
    provincia_nombre: string
    total_hechos: number
    total_victimas: number
  }> = await prisma.$queryRawUnsafe(sql, ...params)

  const provincias: ProvinciaEstadistica[] = rows
    .map(row => {
      const paddedId = row.provincia_id ? row.provincia_id.padStart(2, '0') : ''
      const centroide = PROVINCIAS_CENTROIDES[paddedId]
      if (!centroide) return null

      return {
        provincia: row.provincia_nombre || centroide.nombre,
        provinciaId: paddedId,
        latitud: centroide.latitud,
        longitud: centroide.longitud,
        totalHechos: Number(row.total_hechos),
        totalVictimas: Number(row.total_victimas),
        delitos: [{
          nombre: 'Homicidios dolosos',
          hechos: Number(row.total_hechos),
          victimas: Number(row.total_victimas),
        }],
      }
    })
    .filter((p): p is ProvinciaEstadistica => p !== null)

  const aniosRaw: Array<{ anio: number }> = await prisma.$queryRaw`
    SELECT anio FROM mv_anios_disponibles
    WHERE fuente = 'sat'
    ORDER BY anio
  `

  return {
    provincias,
    aniosDisponibles: aniosRaw.map(a => Number(a.anio)),
  }
}

// ════════════════════════════════════════════
// ROUTER (mantiene la interfaz pública)
// ════════════════════════════════════════════

export async function getEstadisticasPorProvincia(
  anio: number,
  tipoDelitoId?: string,
  fuente: FuenteDatos = 'snic'
): Promise<{ provincias: ProvinciaEstadistica[]; aniosDisponibles: number[] }> {
  if (fuente === 'sat') {
    return getEstadisticasSAT(anio)
  }
  return getEstadisticasSNIC(anio, tipoDelitoId)
}

// ════════════════════════════════════════════
// TENDENCIAS (raw SQL sobre estadisticas_agregadas)
// ════════════════════════════════════════════

export async function getTendencias(
  codigoSnic: string,
  provinciaId?: string
): Promise<{
  tipoDelito: { nombre: string; codigoSnic: string; categoria: string }
  serie: PuntoTendencia[]
} | null> {

  const tipoDelito = await prisma.tipoDelito.findUnique({
    where: { codigoSnic },
  })

  if (!tipoDelito) return null

  let datos: Array<{ anio: number; total_hechos: number; total_victimas: number }>

  if (provinciaId) {
    datos = await prisma.$queryRaw`
      SELECT anio,
             SUM(cantidad_hechos)::int AS total_hechos,
             SUM(cantidad_victimas)::int AS total_victimas
      FROM estadisticas_agregadas
      WHERE tipo_delito_id = ${tipoDelito.id}
        AND provincia_id = ${provinciaId}
      GROUP BY anio
      ORDER BY anio
    `
  } else {
    datos = await prisma.$queryRaw`
      SELECT anio,
             SUM(cantidad_hechos)::int AS total_hechos,
             SUM(cantidad_victimas)::int AS total_victimas
      FROM estadisticas_agregadas
      WHERE tipo_delito_id = ${tipoDelito.id}
      GROUP BY anio
      ORDER BY anio
    `
  }

  const serie: PuntoTendencia[] = datos.map((d, i) => {
    const anterior = i > 0 ? datos[i - 1] : null
    const hechos = Number(d.total_hechos)
    const hechosAnt = anterior ? Number(anterior.total_hechos) : 0
    const variacion = anterior && hechosAnt > 0
      ? Math.round(((hechos - hechosAnt) / hechosAnt * 100) * 10) / 10
      : null

    return {
      anio: Number(d.anio),
      hechos,
      victimas: Number(d.total_victimas),
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

// ════════════════════════════════════════════
// QUERIES EXISTENTES (sin cambios)
// ════════════════════════════════════════════

export async function getTiposDelito() {
  return prisma.tipoDelito.findMany({
    where: { activo: true },
    orderBy: { codigoSnic: 'asc' },
    select: { id: true, codigoSnic: true, nombre: true, categoria: true },
  })
}

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

export async function getDepartamentos(provinciaId: string) {
  const datos = await prisma.ubicacion.findMany({
    where: {
      provinciaId,
      departamentoId: { not: null },
    },
    select: { departamento: true, departamentoId: true },
    distinct: ['departamentoId'],
    orderBy: { departamento: 'asc' },
  })

  return datos
    .filter(d => d.departamento && d.departamentoId)
    .map(d => ({
      departamento: d.departamento!,
      departamentoId: d.departamentoId!,
    }))
}