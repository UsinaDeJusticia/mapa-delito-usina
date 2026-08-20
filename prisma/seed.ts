import { PrismaClient, CategoriaDelito, TipoFuente, NivelConfianza } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding catálogos base...')

  // ── Tipos de delito SNIC (códigos oficiales 1-29, 30, 31, 32) ──
  //
  // El código 0 NO es del catálogo oficial del SNIC: es propio de este
  // proyecto. Existe porque el prompt del pipeline lo ofrece para los casos de
  // "cuerpo hallado sin causa determinada", que son muchos y le importan a
  // Usina —varios se confirman después como femicidios—.
  //
  // Antes el 0 estaba en el prompt y en el validador pero NO acá, y encima el
  // lookup del pipeline usaba la verdad del valor (`datos.codigoSnicEstimado ?
  // ... : null`), donde 0 es falsy. Resultado: cada caso de causa dudosa se
  // descartaba en silencio. Se agrega como categoría real para dejar de
  // perderlos; van con requiereRevision y quedan fuera del mapa público hasta
  // que una persona los confirme (ver /api/mapa/hechos-medios).
  const tiposDelito = [
    { codigoSnic: '0',  nombre: 'Muerte violenta en investigación', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '1',  nombre: 'Homicidios dolosos', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '2',  nombre: 'Homicidios dolosos en grado de tentativa', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '3',  nombre: 'Muertes en siniestros viales', categoria: CategoriaDelito.VIAL },
    { codigoSnic: '4',  nombre: 'Homicidios culposos por otros hechos', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '5',  nombre: 'Lesiones dolosas', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '6',  nombre: 'Lesiones culposas en siniestros viales', categoria: CategoriaDelito.VIAL },
    { codigoSnic: '7',  nombre: 'Lesiones culposas por otros hechos', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '8',  nombre: 'Otros delitos contra las personas', categoria: CategoriaDelito.CONTRA_PERSONAS },
    { codigoSnic: '9',  nombre: 'Delitos contra el honor', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '10', nombre: 'Violaciones', categoria: CategoriaDelito.CONTRA_INTEGRIDAD_SEXUAL },
    { codigoSnic: '11', nombre: 'Otros delitos contra la integridad sexual', categoria: CategoriaDelito.CONTRA_INTEGRIDAD_SEXUAL },
    { codigoSnic: '12', nombre: 'Delitos contra el estado civil', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '13', nombre: 'Amenazas', categoria: CategoriaDelito.CONTRA_LIBERTAD },
    { codigoSnic: '14', nombre: 'Otros delitos contra la libertad', categoria: CategoriaDelito.CONTRA_LIBERTAD },
    { codigoSnic: '15', nombre: 'Robos', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '16', nombre: 'Tentativas de robo', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '17', nombre: 'Robos agravados por resultado de lesiones y/o muertes', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '18', nombre: 'Tentativas de robo agravado por resultado de lesiones y/o muertes', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '19', nombre: 'Hurtos', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '20', nombre: 'Tentativas de hurto', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '21', nombre: 'Otros delitos contra la propiedad', categoria: CategoriaDelito.CONTRA_PROPIEDAD },
    { codigoSnic: '22', nombre: 'Delitos contra la seguridad pública', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '23', nombre: 'Delitos contra el orden público', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '24', nombre: 'Delitos contra la seguridad de la nación', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '25', nombre: 'Delitos contra los poderes públicos y el orden constitucional', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '26', nombre: 'Delitos contra la administración pública', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '27', nombre: 'Delitos contra la fe pública', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '28', nombre: 'Ley 23.737 (estupefacientes)', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '29', nombre: 'Otros delitos previstos en leyes especiales', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '31', nombre: 'Suicidios consumados', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '30', nombre: 'Otros delitos s/seguridad pública', categoria: CategoriaDelito.OTROS },
    { codigoSnic: '32', nombre: 'Delitos s/Leyes Especiales', categoria: CategoriaDelito.OTROS },
  ]

  for (const tipo of tiposDelito) {
    await prisma.tipoDelito.upsert({
      where: { codigoSnic: tipo.codigoSnic },
      update: {},
      create: tipo,
    })
  }
  console.log(`  ✅ ${tiposDelito.length} tipos de delito cargados`)

  // ── Sub-tipos relevantes para Usina ──
  const homicide = await prisma.tipoDelito.findUnique({ where: { codigoSnic: '1' } })
  if (homicide) {
    const subTipos = [
      'Femicidio',
      'Robo seguido de muerte',
      'En ocasión de robo',
      'En riña',
      'Por venganza / ajuste de cuentas',
      'Vinculado a narcotráfico',
      'Por violencia doméstica',
    ]
    for (const nombre of subTipos) {
      await prisma.subTipoDelito.upsert({
        where: { id: `sub-${nombre.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}` },
        update: {},
        create: { id: `sub-${nombre.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`, nombre, tipoDelitoId: homicide.id },
      })
    }
    console.log(`  ✅ ${subTipos.length} sub-tipos de homicidio cargados`)
  }

  // ── Fuentes de datos ──
  const fuentes = [
    { nombre: 'SNIC - Total País', tipo: TipoFuente.OFICIAL, urlBase: 'https://estadisticascriminales.minseg.gob.ar/datos/snic-pais.csv', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'SNIC - Provincias', tipo: TipoFuente.OFICIAL, urlBase: 'https://estadisticascriminales.minseg.gob.ar/datos/snic-provincia.csv', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'SNIC - Departamentos', tipo: TipoFuente.OFICIAL, urlBase: 'https://datos.gob.ar/dataset?organization=seguridad', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'SAT - Homicidios Dolosos', tipo: TipoFuente.OFICIAL, urlBase: 'https://datos.gob.ar', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'SAT - Muertes Viales', tipo: TipoFuente.OFICIAL, urlBase: 'https://datos.gob.ar', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'Mapa del Delito CABA', tipo: TipoFuente.OFICIAL, urlBase: 'https://data.buenosaires.gob.ar', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'RNFJA - Femicidios', tipo: TipoFuente.OFICIAL, urlBase: 'https://www.csjn.gov.ar/omrecopilacion/omfemicidio/', frecuencia: 'anual', confianzaDefault: NivelConfianza.OFICIAL },
    { nombre: 'Casos Usina de Justicia', tipo: TipoFuente.USINA, urlBase: 'https://usinadejusticia.org.ar', frecuencia: 'continua', confianzaDefault: NivelConfianza.VERIFICADO },
  ]

  for (const fuente of fuentes) {
    await prisma.fuente.upsert({
      where: { nombre: fuente.nombre },
      update: {},
      create: fuente,
    })
  }
  console.log(`  ✅ ${fuentes.length} fuentes de datos cargadas`)

  console.log('🎉 Seed completado exitosamente')
}

main()
  .catch((e) => {
    console.error('❌ Error en seed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })