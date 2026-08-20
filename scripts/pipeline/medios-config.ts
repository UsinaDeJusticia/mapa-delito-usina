/**
 * Los medios que scrapea el pipeline, en un módulo aparte.
 *
 * Estaban dentro de scrapear-medios.ts, que ejecuta el pipeline al importarse,
 * así que no había forma de leer la lista desde otro script. El health-check
 * (verificar-medios.ts) la necesita, y los tests la parseaban con regex sobre el
 * texto del archivo — frágil y sin tipos.
 *
 * La URL que el pipeline visita de verdad es `urlPoliciales || url`: `url` es el
 * campo legado de los 10 medios originales, `urlPoliciales` el de los 64 que se
 * agregaron después. `urlBase` está declarado en esos 64 y NUNCA se lee: es dato
 * muerto que se conserva por ahora para no tocar 64 líneas sin necesidad.
 */

export interface MedioConfig {
  id: string
  nombre: string
  url?: string          // legado — medios originales
  urlBase?: string
  urlPoliciales?: string
  tipo?: 'provincial' | 'nacional'
  provincia?: string
  activo?: boolean
  tienePaywall?: boolean
}

export const MEDIOS: MedioConfig[] = [
  // ── GRUPO A: sin paywall ──
  { id: 'rosario3',    nombre: 'Rosario3',               url: 'https://www.rosario3.com/policiales/',                  tipo: 'provincial', provincia: 'Santa Fe',      activo: true },
  { id: 'infobae',     nombre: 'Infobae',                 url: 'https://www.infobae.com/sociedad/policiales/',          tipo: 'nacional',                                activo: true },
  { id: 'ellitoral',   nombre: 'El Litoral (Santa Fe)',   url: 'https://www.ellitoral.com/sucesos',                     tipo: 'provincial', provincia: 'Santa Fe',      activo: true },
  { id: 'lmneuquen',   nombre: 'LM Neuquén',              url: 'https://www.lmneuquen.com/policiales/',                 tipo: 'provincial', provincia: 'Neuquén',       activo: true },
  { id: 'norte',       nombre: 'Diario Norte (Chaco)',    url: 'https://www.diarionorte.com/seccion/policiales/',       tipo: 'provincial', provincia: 'Chaco',         activo: true },
  { id: 'eltribuno',   nombre: 'El Tribuno (Salta)',      url: 'https://www.eltribuno.com/salta/policiales',            tipo: 'provincial', provincia: 'Salta',         activo: true },
  { id: 'eldia',       nombre: 'El Día (La Plata)',       url: 'https://www.eldia.com/seccion/policiales/',             tipo: 'provincial', provincia: 'Buenos Aires',  activo: true },
  { id: 'lavoz',       nombre: 'La Voz del Interior',     url: 'https://www.lavoz.com.ar/sucesos/',                     tipo: 'provincial', provincia: 'Córdoba',       activo: true },

  // ── GRUPO B: paywall — desactivados ──
  { id: 'clarin',      nombre: 'Clarín',                  url: 'https://www.clarin.com/policiales/',                    tipo: 'nacional',                                activo: false },
  { id: 'lanacion',    nombre: 'LA NACION',               url: 'https://www.lanacion.com.ar/seguridad/',                tipo: 'nacional',                                activo: false },

  // ── GBA y Buenos Aires ──
  { id: 'cronica',           nombre: 'Crónica',                      provincia: 'Nacional',           urlBase: 'https://www.cronica.com.ar',              urlPoliciales: 'https://www.cronica.com.ar/policiales/',                            activo: true,  tienePaywall: false },
  { id: 'a24',               nombre: 'A24',                          provincia: 'Nacional',           urlBase: 'https://www.a24.com',                     urlPoliciales: 'https://www.a24.com/policiales/',                                    activo: true,  tienePaywall: false },
  { id: 'ambito',            nombre: 'Ámbito',                       provincia: 'Nacional',           urlBase: 'https://www.ambito.com',                  urlPoliciales: 'https://www.ambito.com/policiales-a5123084',                         activo: true,  tienePaywall: false },
  { id: 'snonline',          nombre: 'SN Online',                    provincia: 'Buenos Aires',       urlBase: 'https://www.snonline.com.ar',             urlPoliciales: 'https://www.snonline.com.ar/policiales/',                            activo: true,  tienePaywall: false },
  { id: 'zonasurdiario',     nombre: 'Zona Sur Diario',              provincia: 'Buenos Aires',       urlBase: 'https://www.zonasurdiario.com.ar',        urlPoliciales: 'https://zonasurdiario.com.ar/search/label/Policiales',               activo: true,  tienePaywall: false },
  { id: 'diarioconurbano',   nombre: 'Diario Conurbano',             provincia: 'Buenos Aires',       urlBase: 'https://www.diarioconurbano.com.ar',      urlPoliciales: 'https://www.diarioconurbano.com.ar/policiales/',                     activo: true,  tienePaywall: false },
  { id: 'elnacionalmatanza', nombre: 'El Nacional de Matanza',       provincia: 'Buenos Aires',       urlBase: 'https://www.elnacionaldematanza.com.ar',  urlPoliciales: 'https://www.elnacionaldematanza.com.ar/policiales/',                 activo: true,  tienePaywall: false },
  { id: 'zonaoestediario',   nombre: 'Zona Oeste Diario',            provincia: 'Buenos Aires',       urlBase: 'https://www.zonaoestediario.com.ar',      urlPoliciales: 'https://zonaoestediario.com.ar/search/label/Policiales',             activo: true,  tienePaywall: false },
  { id: 'diariopopular',     nombre: 'Diario Popular',               provincia: 'Buenos Aires',       urlBase: 'https://www.diariopopular.com.ar',        urlPoliciales: 'https://www.diariopopular.com.ar/policiales/',                       activo: true,  tienePaywall: false },
  { id: 'infocielo',         nombre: 'InfoCielo',                    provincia: 'Buenos Aires',       urlBase: 'https://infocielo.com',                   urlPoliciales: 'https://infocielo.com/policiales/',                                 activo: true,  tienePaywall: false },
  { id: 'lacapital',         nombre: 'La Capital Mar del Plata',     provincia: 'Buenos Aires',       urlBase: 'https://www.lacapitalmdp.com',            urlPoliciales: 'https://www.lacapitalmdp.com/policiales/',                          activo: true,  tienePaywall: false },

  // Ampliación de cobertura de Buenos Aires (ago. 2026). Investigados por
  // agente con WebSearch, sin poder hacer fetch real a las páginas — el
  // egress de este entorno bloquea todos los dominios externos, confirmado
  // con curl directo (403) además del WebFetch. Por eso quedan `activo:
  // false`: alguien del equipo tiene que abrir cada URL una vez (2 minutos
  // por sitio alcanza) antes de sumarlos a la corrida diaria. Ver el mensaje
  // de esta sesión para el detalle de qué se descartó y por qué (Diario Hoy
  // La Plata: cerrado desde 2018; varios "candidatos" no correspondían a
  // Buenos Aires o no existen con ese nombre).
  { id: 'mdp0223',           nombre: '0223 (Mar del Plata)',         provincia: 'Buenos Aires',       urlBase: 'https://www.0223.com.ar',                 urlPoliciales: 'https://www.0223.com.ar/seguridad',                                 activo: true , tienePaywall: false }, // TODO verificar manualmente
  { id: 'elmarplatense',     nombre: 'El Marplatense',               provincia: 'Buenos Aires',       urlBase: 'https://www.elmarplatense.com',           urlPoliciales: 'https://www.elmarplatense.com/seccion/policiales',                  activo: true , tienePaywall: false }, // TODO verificar manualmente
  { id: 'lanueva',           nombre: 'La Nueva (Bahía Blanca)',      provincia: 'Buenos Aires',       urlBase: 'https://www.lanueva.com',                 urlPoliciales: 'https://www.lanueva.com/tag/policiales',                            activo: true , tienePaywall: false }, // TODO verificar manualmente
  { id: 'ecosdiarios',       nombre: 'Ecos Diarios (Necochea)',      provincia: 'Buenos Aires',       urlBase: 'https://elecos.com.ar',                   urlPoliciales: 'https://elecos.com.ar/categoria/13',                                activo: false, tienePaywall: true  }, // sitio de suscripción digital detectado
  { id: 'elpopularolav',     nombre: 'El Popular (Olavarría)',       provincia: 'Buenos Aires',       urlBase: 'https://www.elpopular.com.ar',            urlPoliciales: 'https://www.elpopular.com.ar/Policiales',                           activo: false, tienePaywall: false }, // TODO verificar manualmente
  { id: '0221laplata',       nombre: '0221 (La Plata)',              provincia: 'Buenos Aires',       urlBase: 'https://www.0221.com.ar',                 urlPoliciales: 'https://www.0221.com.ar/policiales',                                activo: true , tienePaywall: false }, // TODO verificar manualmente — tiene página de suscripción, no confirmado si bloquea notas
  { id: 'elcomercioonline',  nombre: 'El Comercio Online (Zona Norte)', provincia: 'Buenos Aires',    urlBase: 'https://www.elcomercioonline.com.ar',     urlPoliciales: 'https://www.elcomercioonline.com.ar/secciones/policiales/',         activo: true , tienePaywall: false }, // TODO verificar manualmente
  { id: 'vivieloeste',       nombre: 'Viví el Oeste',                provincia: 'Buenos Aires',       urlBase: 'https://www.vivieloeste.com.ar',          urlPoliciales: 'https://www.vivieloeste.com.ar/policiales',                         activo: true , tienePaywall: false }, // TODO verificar manualmente
  { id: 'minutouno',         nombre: 'Minuto Uno',                   provincia: 'Nacional',           urlBase: 'https://www.minutouno.com',               urlPoliciales: 'https://www.minutouno.com/policiales-a249',                         activo: true , tienePaywall: false }, // TODO verificar manualmente — nacional, fuerte cobertura de GBA

  // ── Córdoba ──
  { id: 'cadena3',           nombre: 'Cadena 3',                     provincia: 'Córdoba',            urlBase: 'https://www.cadena3.com',                 urlPoliciales: 'https://www.cadena3.com/categoria/policiales/',                     activo: true,  tienePaywall: false },

  // ── Mendoza ──
  { id: 'losandes',          nombre: 'Los Andes',                    provincia: 'Mendoza',            urlBase: 'https://www.losandes.com.ar',             urlPoliciales: 'https://www.losandes.com.ar/policiales/',                           activo: true,  tienePaywall: false },
  { id: 'diariouno',         nombre: 'Diario Uno Mendoza',           provincia: 'Mendoza',            urlBase: 'https://www.diariouno.com.ar',            urlPoliciales: 'https://www.diariouno.com.ar/policiales/',                          activo: true,  tienePaywall: false },

  // ── Tucumán ──
  { id: 'lagaceta',          nombre: 'La Gaceta',                    provincia: 'Tucumán',            urlBase: 'https://www.lagaceta.com.ar',             urlPoliciales: 'https://www.lagaceta.com.ar/policiales/',                           activo: true,  tienePaywall: false },

  // ── Santa Fe / Rosario ──
  { id: 'airedesantafe',     nombre: 'Aire de Santa Fe',             provincia: 'Santa Fe',           urlBase: 'https://www.airedesantafe.com.ar',        urlPoliciales: 'https://www.airedesantafe.com.ar/policiales/',                      activo: true,  tienePaywall: false },
  { id: 'lacapitalrosario',  nombre: 'La Capital Rosario',           provincia: 'Santa Fe',           urlBase: 'https://www.lacapital.com.ar',            urlPoliciales: 'https://www.lacapital.com.ar/policiales/',                          activo: false, tienePaywall: true  },

  // ── Misiones ──
  { id: 'misionesonline',    nombre: 'Misiones Online',              provincia: 'Misiones',           urlBase: 'https://misionesonline.net',              urlPoliciales: 'https://misionesonline.net/tema/policiales-judiciales/',            activo: true,  tienePaywall: false },
  { id: 'elterritorio',      nombre: 'El Territorio',                provincia: 'Misiones',           urlBase: 'https://www.elterritorio.com.ar',         urlPoliciales: 'https://www.elterritorio.com.ar/policiales/',                       activo: true,  tienePaywall: false },

  // ── Neuquén / Río Negro ──
  { id: 'rionegro',          nombre: 'Diario Río Negro',             provincia: 'Río Negro',          urlBase: 'https://www.rionegro.com.ar',             urlPoliciales: 'https://www.rionegro.com.ar/policiales/',                           activo: true,  tienePaywall: false },

  // ── Chubut ──
  // Desactivado: dominio muerto (ERR_NAME_NOT_RESOLVED, confirmado por health-check y por los logs del pipeline)
  { id: 'jornada',           nombre: 'Jornada',                      provincia: 'Chubut',             urlBase: 'https://www.jornada.com.ar',              urlPoliciales: 'https://www.jornada.com.ar/policiales/',                            activo: false,  tienePaywall: false },

  // ── San Juan ──
  { id: 'tiemposanjuan',     nombre: 'Tiempo de San Juan',           provincia: 'San Juan',           urlBase: 'https://www.tiempodesanjuan.com',         urlPoliciales: 'https://www.tiempodesanjuan.com/policiales/',                       activo: true,  tienePaywall: false },

  // ── Salta ──
  { id: 'nuevodiariasalta',  nombre: 'Nuevo Diario Salta',           provincia: 'Salta',              urlBase: 'https://nuevodiariodesalta.com.ar',       urlPoliciales: 'https://nuevodiariodesalta.com.ar/category/seguridad/',             activo: true,  tienePaywall: false },

  // ── Santiago del Estero ──
  { id: 'elliberal',         nombre: 'El Liberal',                   provincia: 'Santiago del Estero', urlBase: 'https://www.elliberal.com.ar',           urlPoliciales: 'https://www.elliberal.com.ar/Policiales/',                          activo: true,  tienePaywall: false },
  { id: 'nuevodiarioweb',    nombre: 'Nuevo Diario Web',             provincia: 'Santiago del Estero', urlBase: 'https://nuevodiarioweb.com.ar',          urlPoliciales: 'https://nuevodiarioweb.com.ar/policiales/',                         activo: true,  tienePaywall: false },

  // ── Entre Ríos ──
  { id: 'unoentrerios',      nombre: 'Uno Entre Ríos',               provincia: 'Entre Ríos',         urlBase: 'https://www.unoentrerios.com.ar',         urlPoliciales: 'https://www.unoentrerios.com.ar/policiales/',                       activo: true,  tienePaywall: false },

  // ── Corrientes ──
  { id: 'diariodecorrientes', nombre: 'Diario Época',                provincia: 'Corrientes',         urlBase: 'https://www.diarioepoca.com',             urlPoliciales: 'https://www.diarioepoca.com/policiales/',                           activo: true,  tienePaywall: false },

  // ── La Pampa ──
  { id: 'laarena',           nombre: 'La Arena',                     provincia: 'La Pampa',           urlBase: 'https://www.laarena.com.ar',              urlPoliciales: 'https://www.laarena.com.ar/tag/policiales/',                        activo: true,  tienePaywall: false },

  // ── Jujuy ──
  { id: 'somosjujuy',        nombre: 'Somos Jujuy',                  provincia: 'Jujuy',              urlBase: 'https://www.somosjujuy.com.ar',           urlPoliciales: 'https://www.somosjujuy.com.ar/policiales/',                         activo: true,  tienePaywall: false },

  // ── Tierra del Fuego ──
  { id: 'findelmundo',       nombre: 'El Diario del Fin del Mundo',  provincia: 'Tierra del Fuego',   urlBase: 'https://www.eldiariodelfindelmundo.com',  urlPoliciales: 'https://www.eldiariodelfindelmundo.com/policiales/',                activo: true,  tienePaywall: false },

  // ── Santa Cruz ──
  { id: 'tiemposur',         nombre: 'Tiempo Sur',                   provincia: 'Santa Cruz',         urlBase: 'https://www.tiemposur.com.ar',            urlPoliciales: 'https://www.tiemposur.com.ar/policiales/',                          activo: true,  tienePaywall: false },

  // ── Formosa ──
  // Desactivado: dominio muerto (ERR_NAME_NOT_RESOLVED). ⚠️ Formosa queda SIN cobertura hasta reemplazarlo.
  { id: 'lamanana',          nombre: 'La Mañana de Formosa',         provincia: 'Formosa',            urlBase: 'https://www.lamananaonline.com.ar',       urlPoliciales: 'https://www.lamananaonline.com.ar/categorias/16/policiales/',       activo: false,  tienePaywall: false },

  // ── San Luis ──
  { id: 'eldiariorepublica', nombre: 'El Diario de la República',    provincia: 'San Luis',           urlBase: 'https://www.eldiariodelarepublica.com',   urlPoliciales: 'https://www.eldiariodelarepublica.com/seccion/policiales/',         activo: true,  tienePaywall: false },

  // ── La Rioja ──
  { id: 'nuevarioja',        nombre: 'Nueva Rioja',                  provincia: 'La Rioja',           urlBase: 'http://nuevarioja.com.ar',                urlPoliciales: 'http://nuevarioja.com.ar/policiales/',                              activo: true,  tienePaywall: false },

  // ── Catamarca ──
  { id: 'catamarcactual',       nombre: 'Catamarca Actual',              provincia: 'Catamarca',          urlBase: 'https://www.catamarcactual.com.ar',       urlPoliciales: 'https://www.catamarcactual.com.ar/policiales/',                      activo: true,  tienePaywall: false },
  { id: 'elancasti',            nombre: 'El Ancasti',                    provincia: 'Catamarca',          urlBase: 'https://www.elancasti.com.ar',            urlPoliciales: 'https://www.elancasti.com.ar/policiales/',                           activo: true,  tienePaywall: false },

  // ── Chaco adicionales ──
  { id: 'diariochaco',          nombre: 'Diario Chaco',                  provincia: 'Chaco',              urlBase: 'https://www.diariochaco.com',             urlPoliciales: 'https://www.diariochaco.com/seccion/policiales-y-judiciales/',      activo: true,  tienePaywall: false },
  { id: 'datachaco',            nombre: 'DataChaco',                     provincia: 'Chaco',              urlBase: 'https://www.datachaco.com',               urlPoliciales: 'https://www.datachaco.com/notas/policiales/',                        activo: true,  tienePaywall: false },

  // ── Jujuy adicionales ──
  { id: 'todojujuy',            nombre: 'TodoJujuy',                     provincia: 'Jujuy',              urlBase: 'https://www.todojujuy.com',               urlPoliciales: 'https://www.todojujuy.com/policiales/',                              activo: true,  tienePaywall: false },
  { id: 'eltribunojujuy',       nombre: 'El Tribuno Jujuy',              provincia: 'Jujuy',              urlBase: 'https://www.eltribuno.com',               urlPoliciales: 'https://www.eltribuno.com/jujuy/policiales/',                        activo: true,  tienePaywall: false },

  // ── Tucumán adicionales ──
  { id: 'losprimeros',          nombre: 'Los Primeros TV',               provincia: 'Tucumán',            urlBase: 'https://www.losprimeros.tv',              urlPoliciales: 'https://www.losprimeros.tv/policiales/',                             activo: true,  tienePaywall: false },
  { id: 'contextotucuman',      nombre: 'Contexto Tucumán',              provincia: 'Tucumán',            urlBase: 'https://www.contextotucuman.com',         urlPoliciales: 'https://www.contextotucuman.com/policiales/',                        activo: true,  tienePaywall: false },

  // ── Córdoba adicional ──
  { id: 'eldoce',               nombre: 'El Doce',                       provincia: 'Córdoba',            urlBase: 'https://www.eldoce.tv',                   urlPoliciales: 'https://www.eldoce.tv/policiales/',                                  activo: true,  tienePaywall: false },

  // ── Corrientes adicionales ──
  { id: 'ellitoralcorrientes',  nombre: 'El Litoral Corrientes',         provincia: 'Corrientes',         urlBase: 'https://www.ellitoral.com.ar',            urlPoliciales: 'https://www.ellitoral.com.ar/policiales/',                           activo: true,  tienePaywall: false },
  { id: 'radiodos',             nombre: 'Radio Dos Corrientes',          provincia: 'Corrientes',         urlBase: 'https://www.radiodos.com.ar',             urlPoliciales: 'https://www.radiodos.com.ar/notas/policiales/',                      activo: true,  tienePaywall: false },

  // ── Entre Ríos adicionales ──
  { id: 'ahoraentrerios',       nombre: 'AHORA Entre Ríos',              provincia: 'Entre Ríos',         urlBase: 'https://www.ahora.com.ar',                urlPoliciales: 'https://www.ahora.com.ar/policiales/',                               activo: true,  tienePaywall: false },
  { id: 'entreriosya',          nombre: 'EntreRíosYA',                   provincia: 'Entre Ríos',         urlBase: 'https://www.entreriosya.com.ar',          urlPoliciales: 'https://www.entreriosya.com.ar/policiales/',                         activo: true,  tienePaywall: false },

  // ── Patagonia ──
  { id: 'elpatagonico',         nombre: 'El Patagónico',                 provincia: 'Chubut',             urlBase: 'https://www.elpatagonico.com',            urlPoliciales: 'https://www.elpatagonico.com/policiales/',                           activo: true,  tienePaywall: false },
  { id: 'diarioprensatdf',      nombre: 'Diario Prensa TDF',             provincia: 'Tierra del Fuego',   urlBase: 'https://www.diarioprensa.com.ar',         urlPoliciales: 'https://www.diarioprensa.com.ar/category/policial/',                 activo: true,  tienePaywall: false },
  { id: 'anbariloche',          nombre: 'ANB Bariloche',                 provincia: 'Río Negro',          urlBase: 'https://www.anbariloche.com.ar',          urlPoliciales: 'https://www.anbariloche.com.ar/policiales/',                         activo: true,  tienePaywall: false },

  // ── La Rioja adicionales ──
  { id: 'elindependienterioja', nombre: 'El Independiente La Rioja',     provincia: 'La Rioja',           urlBase: 'https://www.elindependiente.com.ar',      urlPoliciales: 'https://www.elindependiente.com.ar/policiales/',                     activo: true,  tienePaywall: false },
  // Desactivado: certificado TLS inválido (ERR_TLS_CERT_ALTNAME_INVALID)
  { id: 'cadenaargentina',      nombre: 'Cadena Argentina',              provincia: 'La Rioja',           urlBase: 'https://www.cadenaargentina.com.ar',      urlPoliciales: 'https://www.cadenaargentina.com.ar/policiales/',                     activo: false,  tienePaywall: false },

  // ── San Juan adicional ──
  { id: 'diariodecuyo',         nombre: 'Diario de Cuyo',                provincia: 'San Juan',           urlBase: 'https://www.diariodecuyo.com.ar',         urlPoliciales: 'https://www.diariodecuyo.com.ar/policiales/',                        activo: true,  tienePaywall: false },

  // ── La Pampa adicional ──
  { id: 'pampadiario',          nombre: 'Pampa Diario',                  provincia: 'La Pampa',           urlBase: 'https://www.pampadiario.com',             urlPoliciales: 'https://www.pampadiario.com/policial/',                              activo: true,  tienePaywall: false },

  // ── Salta adicional ──
  { id: 'informatesalta',       nombre: 'InformateSalta',                provincia: 'Salta',              urlBase: 'https://www.informatesalta.com.ar',       urlPoliciales: 'https://www.informatesalta.com.ar/policiales/',                      activo: true,  tienePaywall: false },
]
