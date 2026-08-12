import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'
import { PrismaClient, TipoDelito } from '@prisma/client'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('ERROR FATAL: La variable DATABASE_URL no está definida. Revisa el archivo .env')
}
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
})

const PROVINCIAS_CENTROIDES: Record<string, { latitud: number; longitud: number; nombre: string; nombreNormalizado: string }> = {
  '02': { latitud: -34.6037, longitud: -58.3816, nombre: 'CABA', nombreNormalizado: 'caba' },
  '06': { latitud: -34.9965, longitud: -64.9673, nombre: 'Buenos Aires', nombreNormalizado: 'buenos_aires' },
  '10': { latitud: -24.1836, longitud: -65.4152, nombre: 'Catamarca', nombreNormalizado: 'catamarca' },
  '14': { latitud: -31.4201, longitud: -64.1888, nombre: 'Córdoba', nombreNormalizado: 'cordoba' },
  '18': { latitud: -28.8550, longitud: -57.9562, nombre: 'Corrientes', nombreNormalizado: 'corrientes' },
  '22': { latitud: -27.4698, longitud: -58.9718, nombre: 'Chaco', nombreNormalizado: 'chaco' },
  '26': { latitud: -43.3000, longitud: -65.1000, nombre: 'Chubut', nombreNormalizado: 'chubut' },
  '30': { latitud: -33.0139, longitud: -58.2513, nombre: 'Entre Ríos', nombreNormalizado: 'entre_rios' },
  '34': { latitud: -27.4698, longitud: -58.8306, nombre: 'Formosa', nombreNormalizado: 'formosa' },
  '38': { latitud: -22.1059, longitud: -65.4036, nombre: 'Jujuy', nombreNormalizado: 'jujuy' },
  '42': { latitud: -36.6167, longitud: -64.2833, nombre: 'La Pampa', nombreNormalizado: 'la_pampa' },
  '46': { latitud: -28.4993, longitud: -65.7774, nombre: 'La Rioja', nombreNormalizado: 'la_rioja' },
  '50': { latitud: -32.8895, longitud: -68.8458, nombre: 'Mendoza', nombreNormalizado: 'mendoza' },
  '54': { latitud: -27.3623, longitud: -55.9408, nombre: 'Misiones', nombreNormalizado: 'misiones' },
  '58': { latitud: -41.7644, longitud: -68.3303, nombre: 'Neuquén', nombreNormalizado: 'neuquen' },
  '62': { latitud: -40.8136, longitud: -68.3593, nombre: 'Río Negro', nombreNormalizado: 'rio_negro' },
  '66': { latitud: -24.9420, longitud: -60.6039, nombre: 'Salta', nombreNormalizado: 'salta' },
  '70': { latitud: -29.8815, longitud: -67.4738, nombre: 'San Juan', nombreNormalizado: 'san_juan' },
  '74': { latitud: -33.2967, longitud: -66.3347, nombre: 'San Luis', nombreNormalizado: 'san_luis' },
  '78': { latitud: -51.6238, longitud: -69.2168, nombre: 'Santa Cruz', nombreNormalizado: 'santa_cruz' },
  '82': { latitud: -29.8828, longitud: -67.7091, nombre: 'Santa Fe', nombreNormalizado: 'santa_fe' },
  '86': { latitud: -28.0716, longitud: -65.2042, nombre: 'Santiago del Estero', nombreNormalizado: 'sgo_estero' },
  '90': { latitud: -27.3306, longitud: -55.1149, nombre: 'Tucumán', nombreNormalizado: 'tucuman' },
  '94': { latitud: -54.8075, longitud: -68.3020, nombre: 'Tierra del Fuego', nombreNormalizado: 'tierra_fuego' }
}

const PROVINCIA_POR_NOMBRE: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCIAS_CENTROIDES).map(([id, data]) => [data.nombreNormalizado, id])
)

const DIRECTORIO_DATOS = path.join(process.cwd(), 'data', 'snic')

const cacheTipoDelito = new Map<string, TipoDelito | null>()
const cacheUbicacion = new Map<string, string>()
const erroresCodigoDelito = new Set<string>()

let totalFilasProcesadas = 0

interface FilaSNIC {
  anio: number
  provincia?: string
  provinciaId?: string
  codigoDelito: string
  cantidadHechos: number
  cantidadVictimas?: number
}

function esColumnaDelitoPais(columna: string): boolean {
  return /^delito_\d+_(hechos|victimas)$/.test(columna)
}

function esColumnaDelitoProvincia(columna: string): boolean {
  return /^delito_\d+_(hechos|victi)_.+$/.test(columna)
}

function extraerCodigoDelitoProvincia(columna: string): { codigo: string; provincia: string } | null {
  const match = columna.match(/^delito_(\d+)_(hechos|victi)_(.+)$/)
  if (!match) return null
  return {
    codigo: match[1],
    provincia: match[3],
  }
}

function extraerCodigoDelitoPais(columna: string): string | null {
  const match = columna.match(/^delito_(\d+)_(hechos|victimas)$/)
  return match ? match[1] : null
}

async function obtenerTipoDelito(codigoSnic: string): Promise<TipoDelito | null> {
  if (erroresCodigoDelito.has(codigoSnic)) {
    return null
  }

  if (cacheTipoDelito.has(codigoSnic)) {
    return cacheTipoDelito.get(codigoSnic) ?? null
  }

  const tipoDelito = await prisma.tipoDelito.findUnique({
    where: { codigoSnic },
  })

  if (!tipoDelito) {
    erroresCodigoDelito.add(codigoSnic)
  }

  cacheTipoDelito.set(codigoSnic, tipoDelito)
  return tipoDelito
}

async function obtenerOuCrearUbicacion(provinciaId: string | undefined) {
  const key = provinciaId || 'argentina'

  if (cacheUbicacion.has(key)) {
    return { id: cacheUbicacion.get(key)! }
  }

  let ubicacionId: string

  if (!provinciaId) {
    const resultado = await prisma.ubicacion.upsert({
      where: { id: 'ubicacion-argentina' },
      update: {},
      create: {
        id: 'ubicacion-argentina',
        provincia: 'Argentina',
        provinciaId: '0',
        latitud: -38.4161,
        longitud: -63.6167,
        esCentroide: true,
      },
    })
    ubicacionId = resultado.id
  } else {
    const centroide = PROVINCIAS_CENTROIDES[provinciaId]
    if (!centroide) {
      return null
    }

    const resultado = await prisma.ubicacion.upsert({
      where: { id: `ubicacion-${provinciaId}` },
      update: {},
      create: {
        id: `ubicacion-${provinciaId}`,
        provincia: centroide.nombre,
        provinciaId,
        latitud: centroide.latitud,
        longitud: centroide.longitud,
        esCentroide: true,
      },
    })
    ubicacionId = resultado.id
  }

  cacheUbicacion.set(key, ubicacionId)
  return { id: ubicacionId }
}

function procesarArchivoPais(contenido: string): FilaSNIC[] {
  const resultado = Papa.parse(contenido.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
  })

  const filasProcesadas: FilaSNIC[] = []
  const columnasDelito = resultado.meta.fields?.filter(esColumnaDelitoPais) || []

  for (const fila of resultado.data) {
    const filaObj = fila as Record<string, string>
    const anio = parseInt(filaObj.indice_tiempo, 10)
    if (isNaN(anio)) continue

    for (const columna of columnasDelito) {
      const codigoDelito = extraerCodigoDelitoPais(columna)
      if (codigoDelito === null) continue

      const cantidadStr = filaObj[columna]
      const cantidad = parseInt(cantidadStr || '0', 10)
      if (isNaN(cantidad) || cantidad === 0) continue

      filasProcesadas.push({
        anio,
        codigoDelito,
        cantidadHechos: cantidad,
      })
    }
  }

  return filasProcesadas
}

function procesarArchivoProvincia(contenido: string): FilaSNIC[] {
  const resultado = Papa.parse(contenido.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
  })

  const filasProcesadas: FilaSNIC[] = []
  const columnasDelito = resultado.meta.fields?.filter(esColumnaDelitoProvincia) || []

  for (const fila of resultado.data) {
    const filaObj = fila as Record<string, string>
    const anio = parseInt(filaObj.indice_tiempo, 10)
    if (isNaN(anio)) continue

    for (const columna of columnasDelito) {
      const resultadoExtraccion = extraerCodigoDelitoProvincia(columna)
      if (!resultadoExtraccion) continue

      const { codigo, provincia } = resultadoExtraccion
      const provinciaId = PROVINCIA_POR_NOMBRE[provincia]

      if (!provinciaId) continue

      const cantidadStr = filaObj[columna]
      const cantidad = parseInt(cantidadStr || '0', 10)
      if (isNaN(cantidad) || cantidad === 0) continue

      filasProcesadas.push({
        anio,
        provinciaId,
        provincia,
        codigoDelito: codigo,
        cantidadHechos: cantidad,
      })
    }
  }

  return filasProcesadas
}

async function cargarArchivo(rutaArchivo: string, esDryRun: boolean): Promise<FilaSNIC[]> {
  const esTotalPais = rutaArchivo.includes('pais')
  const esProvincia = rutaArchivo.includes('provincia')

  const fuenteNombre = esTotalPais ? 'SNIC - Total País' : esProvincia ? 'SNIC - Provincias' : 'SNIC'

  const fuente = await prisma.fuente.findUnique({
    where: { nombre: fuenteNombre },
  })

  if (!fuente) {
    throw new Error(`Fuente "${fuenteNombre}" no encontrada en la base de datos`)
  }

  const contenido = fs.readFileSync(rutaArchivo, { encoding: 'utf-8' })

  let filasProcesadas: FilaSNIC[]

  if (esTotalPais) {
    filasProcesadas = procesarArchivoPais(contenido)
  } else if (esProvincia) {
    filasProcesadas = procesarArchivoProvincia(contenido)
  } else {
    throw new Error('Tipo de archivo no reconocido')
  }

  console.log(`📊 Registros a procesar: ${filasProcesadas.length}`)

  if (esDryRun) {
    console.table(filasProcesadas.slice(0, 10))
    return []
  }

  for (let i = 0; i < filasProcesadas.length; i++) {
    const fila = filasProcesadas[i]

    if (i > 0 && i % 500 === 0) {
      console.log(`[PROGRESO] ${i}/${filasProcesadas.length} filas procesadas...`)
    }

    try {
      const tipoDelito = await obtenerTipoDelito(fila.codigoDelito)
      if (!tipoDelito) continue

      const ubicacion = await obtenerOuCrearUbicacion(fila.provinciaId)
      if (!ubicacion) continue

      await prisma.hechoDelictivo.upsert({
        where: {
          id: `hecho-${fila.anio}-${tipoDelito.id}-${ubicacion.id}-${fuente.id}`,
        },
        update: {
          cantidadHechos: fila.cantidadHechos,
        },
        create: {
          id: `hecho-${fila.anio}-${tipoDelito.id}-${ubicacion.id}-${fuente.id}`,
          tipoDelitoId: tipoDelito.id,
          fechaHecho: new Date(fila.anio, 0, 1),
          anio: fila.anio,
          ubicacionId: ubicacion.id,
          fuenteId: fuente.id,
          confianza: fuente.confianzaDefault,
          cantidadHechos: fila.cantidadHechos,
          esAgregado: true,
        },
      })

      totalFilasProcesadas++
    } catch (error) {
      console.error(`❌ Error al procesar fila:`, error)
    }
  }

  return filasProcesadas
}

async function main() {
  const args = process.argv.slice(2)
  const esDryRun = args.includes('--dry-run')

  console.log(esDryRun ? '🔍 Modo DRY-RUN (sin persistir en BD)' : '📦 Modo normal')

  if (!fs.existsSync(DIRECTORIO_DATOS)) {
    console.error(`❌ Directorio no encontrado: ${DIRECTORIO_DATOS}`)
    process.exit(1)
  }

  const archivos = fs.readdirSync(DIRECTORIO_DATOS).filter((f) => f.endsWith('.csv'))

  console.log(`📁 Archivos encontrados: ${archivos.length}`)

  for (const archivo of archivos) {
    console.log(`\n📄 Procesando: ${archivo}`)
    const ruta = path.join(DIRECTORIO_DATOS, archivo)

    await cargarArchivo(ruta, esDryRun)
  }

  console.log(`\n🎉 Carga completada. Total insertados: ${totalFilasProcesadas}`)
}

main()
  .catch((e) => {
    console.error('❌ Error fatal:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })