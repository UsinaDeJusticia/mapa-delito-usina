import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('=== victimaSexo ===')
  const result1 = await prisma.$queryRaw`
    SELECT 'victimaSexo' AS campo, "victimaSexo" AS valor, COUNT(*) AS total
    FROM hechos_delictivos WHERE es_agregado = false AND "victimaSexo" IS NOT NULL
    GROUP BY "victimaSexo" ORDER BY total DESC
  `
  console.log(result1)

  console.log('\n=== medioComision ===')
  const result2 = await prisma.$queryRaw`
    SELECT 'medioComision' AS campo, "medioComision" AS valor, COUNT(*) AS total
    FROM hechos_delictivos WHERE es_agregado = false AND "medioComision" IS NOT NULL
    GROUP BY "medioComision" ORDER BY total DESC
  `
  console.log(result2)

  console.log('\n=== femicidio ===')
  const result3 = await prisma.$queryRaw`
    SELECT 'femicidio' AS campo, femicidio AS valor, COUNT(*) AS total
    FROM hechos_delictivos WHERE es_agregado = false AND femicidio IS NOT NULL
    GROUP BY femicidio ORDER BY total DESC
  `
  console.log(result3)

  console.log('\n=== vinculoVictimaVictimario ===')
  const result4 = await prisma.$queryRaw`
    SELECT 'vinculo' AS campo, "vinculoVictimaVictimario" AS valor, COUNT(*) AS total
    FROM hechos_delictivos WHERE es_agregado = false AND "vinculoVictimaVictimario" IS NOT NULL
    GROUP BY "vinculoVictimaVictimario" ORDER BY total DESC
  `
  console.log(result4)

  console.log('\n=== lugarHecho ===')
  const result5 = await prisma.$queryRaw`
    SELECT 'lugarHecho' AS campo, "lugarHecho" AS valor, COUNT(*) AS total
    FROM hechos_delictivos WHERE es_agregado = false AND "lugarHecho" IS NOT NULL
    GROUP BY "lugarHecho" ORDER BY total DESC
  `
  console.log(result5)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
