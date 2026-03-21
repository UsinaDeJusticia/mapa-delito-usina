/**
 * Script one-time: actualiza los centroides de las ubicaciones provinciales
 * con datos oficiales de la API Georef Argentina (IGN).
 *
 * Uso: npx tsx scripts/actualizar-centroides.ts
 */

import { PrismaClient } from '@prisma/client'
import { getProvinciasGeoref } from '../src/lib/mapa/georef'

const prisma = new PrismaClient()

async function main() {
  console.log('🌍 Actualizando centroides con API Georef...')

  const provinciasGeoref = await getProvinciasGeoref()
  if (provinciasGeoref.length === 0) {
    console.error('❌ No se pudieron obtener datos de Georef. ¿Está disponible la API?')
    process.exit(1)
  }

  console.log(`📊 ${provinciasGeoref.length} provincias obtenidas de Georef`)

  let actualizadas = 0

  for (const prov of provinciasGeoref) {
    // Buscar la ubicación en la BD por provinciaId
    const ubicacion = await prisma.ubicacion.findFirst({
      where: { provinciaId: prov.id, esCentroide: true }
    })

    if (ubicacion) {
      await prisma.ubicacion.update({
        where: { id: ubicacion.id },
        data: {
          latitud: prov.centroide.lat,
          longitud: prov.centroide.lon,
        }
      })
      console.log(`  ✅ ${prov.nombre}: ${prov.centroide.lat}, ${prov.centroide.lon}`)
      actualizadas++
    } else {
      console.log(`  ⚠️  ${prov.nombre} (ID: ${prov.id}) no encontrada en BD`)
    }
  }

  console.log(`\n🎉 ${actualizadas} centroides actualizados con datos oficiales IGN`)
}

main()
  .catch(e => { console.error('❌ Error:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())