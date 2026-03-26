const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        COUNT(*)::bigint as total_hechos,
        COUNT(u.departamento_id)::bigint as con_departamento,
        COUNT(DISTINCT u.departamento_id)::bigint as departamentos_unicos,
        COUNT(DISTINCT u.provincia_id)::bigint as provincias_unicas,
        COUNT(CASE WHEN h.es_agregado = false THEN 1 END)::bigint as hechos_individuales,
        COUNT(CASE WHEN h.es_agregado = true THEN 1 END)::bigint as hechos_agregados
      FROM hechos_delictivos h
      LEFT JOIN ubicaciones u ON h.ubicacion_id = u.id
    `)
    console.log('Stats HechoDelictivo:')
    result.forEach(r => {
      console.log(`  Total hechos: ${Number(r.total_hechos)}`)
      console.log(`  Con departamento: ${Number(r.con_departamento)}`)
      console.log(`  Deptos únicos: ${Number(r.departamentos_unicos)}`)
      console.log(`  Provincias únicas: ${Number(r.provincias_unicas)}`)
      console.log(`  Individuales: ${Number(r.hechos_individuales)}`)
      console.log(`  Agregados: ${Number(r.hechos_agregados)}`)
    })
  } catch (e) {
    console.error('Error:', e.message)
  }
  await prisma.$disconnect()
}
main()
