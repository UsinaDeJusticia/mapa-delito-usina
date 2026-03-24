import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SUBTIPOS = [
  { codigo: '11_1', nombre: 'Tentativa de abuso sexual con acceso carnal', categoria: 'CONTRA_INTEGRIDAD_SEXUAL', padre: '11' },
  { codigo: '11_2', nombre: 'Abuso sexual simple', categoria: 'CONTRA_INTEGRIDAD_SEXUAL', padre: '11' },
  { codigo: '11_3', nombre: 'Abuso sexual agravado', categoria: 'CONTRA_INTEGRIDAD_SEXUAL', padre: '11' },
  { codigo: '11_4', nombre: 'Ciberdelitos sexuales vinculados a menores', categoria: 'CONTRA_INTEGRIDAD_SEXUAL', padre: '11' },
  { codigo: '11_5', nombre: 'Otros delitos contra la integridad sexual', categoria: 'CONTRA_INTEGRIDAD_SEXUAL', padre: '11' },
  { codigo: '14_1', nombre: 'Trata de personas simple', categoria: 'CONTRA_LIBERTAD', padre: '14' },
  { codigo: '14_2', nombre: 'Trata de personas agravado', categoria: 'CONTRA_LIBERTAD', padre: '14' },
  { codigo: '14_3', nombre: 'Otros delitos contra la libertad', categoria: 'CONTRA_LIBERTAD', padre: '14' },
  { codigo: '21_1', nombre: 'Extorsiones', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_2', nombre: 'Secuestros extorsivos', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_3', nombre: 'Estafas y defraudaciones (no incluye virtuales) y usura', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_4', nombre: 'Estafas y defraudaciones asistidas virtualmente', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_5', nombre: 'Daños (no incluye informáticos)', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_6', nombre: 'Acceso ilegal a sistemas informáticos y daños informáticos', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '21_7', nombre: 'Otros delitos contra la propiedad', categoria: 'CONTRA_PROPIEDAD', padre: '21' },
  { codigo: '22_1', nombre: 'Fabricación adquisición transferencia y tenencia de explosivos', categoria: 'OTROS', padre: '22' },
  { codigo: '22_2', nombre: 'Tenencia ilegal de armas de fuego', categoria: 'OTROS', padre: '22' },
  { codigo: '22_3', nombre: 'Portación ilegal de armas de fuego', categoria: 'OTROS', padre: '22' },
  { codigo: '22_4', nombre: 'Acopio y fabricación ilegal de armas piezas y municiones', categoria: 'OTROS', padre: '22' },
  { codigo: '22_5', nombre: 'Entrega y comercialización ilegal de armas de fuego', categoria: 'OTROS', padre: '22' },
  { codigo: '22_6', nombre: 'Omisión adulteración y supresión de marcaje', categoria: 'OTROS', padre: '22' },
  { codigo: '22_7', nombre: 'Otros delitos contra la seguridad pública', categoria: 'OTROS', padre: '22' },
  { codigo: '28_1', nombre: 'Siembra y producción de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_2', nombre: 'Comercialización y entrega de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_3', nombre: 'Tenencia o entrega atenuada de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_4', nombre: 'Desvío de Importación de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_5', nombre: 'Organización y financiación de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_6', nombre: 'Tenencia simple de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_7', nombre: 'Tenencia simple atenuada para uso personal de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_8', nombre: 'Confabulación de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_9', nombre: 'Contrabando de estupefacientes', categoria: 'OTROS', padre: '28' },
  { codigo: '28_10', nombre: 'Otros delitos previstos en la ley 23.737', categoria: 'OTROS', padre: '28' },
  { codigo: '29_1', nombre: 'Ley de residuos peligrosos', categoria: 'OTROS', padre: '29' },
  { codigo: '29_2', nombre: 'Ley de fauna', categoria: 'OTROS', padre: '29' },
  { codigo: '29_3', nombre: 'Delitos migratorios', categoria: 'OTROS', padre: '29' },
  { codigo: '29_4', nombre: 'Obstrucción del código aduanero', categoria: 'OTROS', padre: '29' },
  { codigo: '29_5', nombre: 'Contrabando Simple', categoria: 'OTROS', padre: '29' },
  { codigo: '29_6', nombre: 'Contrabando Agravado', categoria: 'OTROS', padre: '29' },
  { codigo: '29_7', nombre: 'Contrabando de elementos nucleares agresivos químicos armas y municiones', categoria: 'OTROS', padre: '29' },
  { codigo: '29_8', nombre: 'Otros delitos previstos en leyes especiales', categoria: 'OTROS', padre: '29' },
]

async function main() {
  console.log('Insertando subcategorías SNIC...')

  let insertados = 0
  let omitidos = 0

  for (const sub of SUBTIPOS) {
    const tipoPadre = await prisma.tipoDelito.findUnique({
      where: { codigoSnic: sub.padre }
    })

    if (!tipoPadre) {
      console.log(`  OMITIDO: TipoDelito "${sub.padre}" no existe para ${sub.codigo}`)
      omitidos++
      continue
    }

    await prisma.tipoDelito.upsert({
      where: { codigoSnic: sub.codigo },
      update: {},
      create: {
        codigoSnic: sub.codigo,
        nombre: sub.nombre,
        categoria: sub.categoria as any,
      }
    })
    insertados++
  }

  console.log(`\nCompletado: ${insertados} insertados, ${omitidos} omitidos`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
