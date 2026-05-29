/**
 * Pipeline de scraping de medios periodísticos.
 *
 * Flujo completo:
 * 1. agent-browser (CLI) navega secciones policiales de cada medio
 * 2. Extrae URLs y texto de noticias recientes
 * 3. OpenRouter (DeepSeek/Qwen) extrae datos estructurados
 * 4. Deduplicador IA determina si es hecho nuevo o cobertura existente
 * 5. API Georef normaliza ubicaciones
 * 6. Se inserta en Neon con confianza PRELIMINAR
 *
 * Uso:
 *   npx tsx scripts/pipeline/scrapear-medios.ts
 *   npx tsx scripts/pipeline/scrapear-medios.ts --dry-run
 *   npx tsx scripts/pipeline/scrapear-medios.ts --medio=infobae
 */

import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
import { extraerDatosNoticia } from '../../src/lib/mapa/openrouter'
import { deduplicar, clasificarCobertura } from '../../src/lib/mapa/deduplicador'
import { getConfigActiva } from '../../src/config/modelos-pipeline'

const prisma = new PrismaClient()

// ════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════

const DRY_RUN = process.argv.includes('--dry-run') || process.env.PIPELINE_DRY_RUN === 'true'
const MAX_NOTICIAS = parseInt(process.env.PIPELINE_MAX_NOTICIAS || '20')
const MEDIO_ESPECIFICO = process.argv.find(a => a.startsWith('--medio='))?.split('=')[1]
const CONFIANZA_MINIMA = 85

// ════════════════════════════════════════════
// FILTRO DE HOMICIDIOS
// ════════════════════════════════════════════

const PALABRAS_CLAVE_HOMICIDIO = [
  'matar', 'mató', 'mataron',
  'asesi', // asesinó, asesinaron, asesinato
  'homicid', // homicidio, homicida
  'femicid', // femicidio
  'murió', 'murio', 'murieron',
  'falleci', // falleció, fallecieron, fallecida
  'cadáver', 'cadaver',
  'cuerpo sin vida',
  'baleado', 'balearon',
  'apuñalado', 'apuñalaron',
  'muertos', 'muerto',
  'muerte', // "muerte violenta", "causa de muerte", "muerte de"
  'víctima fatal', 'victima fatal',
  'herido de gravedad', 'heridos de gravedad',
  'estado crítico', 'estado critico',
  'tiroteo mortal',
  'ejecutaron', 'ejecutado',
  'dispararon', 'disparo mortal',
  // 'crimen' eliminado — matchea "crimen organizado" en noticias de drogas
]

// Descarte inmediato: si el TÍTULO contiene alguna de estas palabras
// y NO contiene indicadores de muerte, se descarta sin gastar tokens.
const PALABRAS_DESCARTE_INMEDIATO = [
  'detuvieron', 'detuvo', 'fue detenido', 'fue arrestado',
  'incautaron', 'secuestraron droga', 'tráfico de',
  'narcotráfico', 'estupefacientes', 'cocaína',
  'marihuana', 'condenaron', 'fue condenado',
  'años de prisión', 'fue imputado',
  // 'droga' eliminado — demasiado amplio, descarta "mujer drogada fue asesinada"
  // 'sentencia' eliminado — puede ser condena por homicidio (cobertura válida)
]

// ════════════════════════════════════════════
// TIPOS
// ════════════════════════════════════════════

interface MedioConfig {
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

interface NoticiaScrapeada {
  titulo: string
  texto: string
  url: string
  medio: string
  medioTipo: 'provincial' | 'nacional'
  provinciaOrigen?: string
}

// ════════════════════════════════════════════
// MEDIOS A SCRAPEAR
// ════════════════════════════════════════════

const MEDIOS: MedioConfig[] = [
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
  { id: 'jornada',           nombre: 'Jornada',                      provincia: 'Chubut',             urlBase: 'https://www.jornada.com.ar',              urlPoliciales: 'https://www.jornada.com.ar/policiales/',                            activo: true,  tienePaywall: false },

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
  { id: 'lamanana',          nombre: 'La Mañana de Formosa',         provincia: 'Formosa',            urlBase: 'https://www.lamananaonline.com.ar',       urlPoliciales: 'https://www.lamananaonline.com.ar/categorias/16/policiales/',       activo: true,  tienePaywall: false },

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
  { id: 'cadenaargentina',      nombre: 'Cadena Argentina',              provincia: 'La Rioja',           urlBase: 'https://www.cadenaargentina.com.ar',      urlPoliciales: 'https://www.cadenaargentina.com.ar/policiales/',                     activo: true,  tienePaywall: false },

  // ── San Juan adicional ──
  { id: 'diariodecuyo',         nombre: 'Diario de Cuyo',                provincia: 'San Juan',           urlBase: 'https://www.diariodecuyo.com.ar',         urlPoliciales: 'https://www.diariodecuyo.com.ar/policiales/',                        activo: true,  tienePaywall: false },

  // ── La Pampa adicional ──
  { id: 'pampadiario',          nombre: 'Pampa Diario',                  provincia: 'La Pampa',           urlBase: 'https://www.pampadiario.com',             urlPoliciales: 'https://www.pampadiario.com/policial/',                              activo: true,  tienePaywall: false },

  // ── Salta adicional ──
  { id: 'informatesalta',       nombre: 'InformateSalta',                provincia: 'Salta',              urlBase: 'https://www.informatesalta.com.ar',       urlPoliciales: 'https://www.informatesalta.com.ar/policiales/',                      activo: true,  tienePaywall: false },
]

// ════════════════════════════════════════════
// UTILIDADES
// ════════════════════════════════════════════

function log(emoji: string, msg: string, data?: unknown) {
  const ts = new Date().toLocaleTimeString('es-AR')
  console.log(`${emoji} [${ts}] ${msg}`)
  if (data) console.log('   ', JSON.stringify(data, null, 2))
}

/**
 * Ejecuta un comando de agent-browser CLI y devuelve el output.
 */
function agentCmd(comando: string, timeoutMs: number = 30000): string {
  try {
    const resultado = execSync(`agent-browser ${comando}`, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return resultado.trim()
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
    if (err.killed) {
      log('⚠️', `Timeout: agent-browser ${comando.slice(0, 60)}...`)
    } else if (err.stderr) {
      log('⚠️', `Error agent-browser: ${err.stderr.slice(0, 150)}`)
    }
    return ''
  }
}

/**
 * Usa IA (DeepSeek via OpenRouter) para identificar qué refs del snapshot
 * son links a noticias policiales/de seguridad.
 *
 * Esto reemplaza el parseo por regex y funciona en CUALQUIER sitio
 * sin configuración específica.
 */
async function identificarNoticiasConIA(
  snapshot: string,
  medio: string
): Promise<Array<{ ref: string; titulo: string }>> {

  const config = getConfigActiva()
  const apiKey = config.proveedor === 'ollama'
    ? 'ollama'
    : process.env.OPENROUTER_API_KEY || ''
  const baseURL = config.proveedor === 'ollama'
    ? `${config.baseUrl}/v1`
    : config.baseUrl

  const openrouter = new (await import('openai')).default({
    baseURL,
    apiKey,
    defaultHeaders: config.proveedor === 'openrouter' ? {
      'HTTP-Referer': 'https://usinadejusticia.org.ar',
      'X-Title': 'Mapa del Delito - Identificador',
    } : {},
  })

  const modelo = config.modelo

  try {
    const respuesta = await openrouter.chat.completions.create({
      model: modelo,
      messages: [
        {
          role: 'system',
          content: `Sos un analista especializado en identificar noticias sobre MUERTES VIOLENTAS en sitios argentinos.

Te voy a pasar el snapshot de accesibilidad de un sitio de noticias. Cada elemento tiene un ref (ej: e123).
Tu trabajo es identificar SOLO los links de noticias donde hay UNA O MÁS PERSONAS MUERTAS:
homicidios, femicidios, asesinatos, tiroteos con víctimas fatales, muertes violentas, cuerpos hallados.

NO incluir: robos sin muerte, detenciones, arrestos, drogas sin muerte, política, deportes, economía, espectáculos, heridos sin muerte.

Respondé SOLO con JSON array. Si no hay noticias con muertos, respondé [].
Formato: [{"ref": "e123", "titulo": "Texto del link"}]
Máximo 10 resultados.`
        },
        {
          role: 'user',
          content: `Snapshot del sitio ${medio}:\n\n${snapshot.slice(0, 3000)}`
        }
      ],
      temperature: 0.1,
      max_tokens: 800,
    })

    const contenido = respuesta.choices[0]?.message?.content?.trim() || '[]'
    const jsonLimpio = contenido
      .replace(/^```json\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim()

    const resultado = JSON.parse(jsonLimpio)
    return Array.isArray(resultado) ? resultado : []

  } catch (error) {
    const err = error as { message?: string; status?: number; response?: { data?: unknown } }
    console.error('Error identificación detalle:', err.message, err.status, err.response?.data)
    log('⚠️', `Error en identificación IA: ${err.message ?? String(error)}`)
    return []
  }
}

/**
 * Pre-warm del daemon de agent-browser.
 * La primera ejecución levanta Chromium y puede tardar 30-60 segundos.
 * Haciendo open about:blank primero, las navegaciones reales son rápidas.
 */
function prewarmDaemon(): boolean {
  log('🔥', 'Pre-warming agent-browser daemon...')
  const result = agentCmd('open about:blank', 90000) // 90s para cold-start
  if (result === '') {
    // Puede devolver vacío pero funcionar igual, verificar con get url
    const url = agentCmd('get url', 5000)
    if (!url) {
      log('❌', 'No se pudo iniciar agent-browser')
      return false
    }
  }
  log('✅', 'Daemon listo')
  return true
}

/**
 * Scrapea un medio usando el Tab Isolation Pattern.
 *
 * Flujo (basado en issue #853 de agent-browser):
 * 1. Pre-warm (solo la primera vez)
 * 2. Navegar a la sección policial en tab 0
 * 3. Snapshot -i para obtener refs de links
 * 4. Para cada link:
 *    - click @ref --new-tab (abre en tab nueva)
 *    - tab 1 (cambiar a la tab de detalle)
 *    - Extraer texto del artículo
 *    - tab close (cerrar tab de detalle)
 *    - tab 0 (volver al listado, refs intactos)
 * 5. Cerrar browser
 */
async function scrapearMedio(medio: MedioConfig, yaPrewarmed: boolean): Promise<NoticiaScrapeada[]> {
  const urlTarget = medio.urlPoliciales || medio.url || ''
  log('📰', `Scrapeando ${medio.nombre} (${urlTarget})`)
  const noticias: NoticiaScrapeada[] = []

  try {
    // 1. Navegar a la sección policial
    agentCmd(`open "${urlTarget}"`, 30000)
    agentCmd('wait --load networkidle', 20000)

    // 2. Snapshot interactivo para obtener refs de links
    const snapshot = agentCmd('snapshot -i -c', 15000)

    if (!snapshot) {
      log('⚠️', `No se pudo obtener snapshot de ${medio.nombre}`)
      return []
    }

    // 3. Identificar noticias policiales con IA (funciona en cualquier sitio)
    log('🤖', `Identificando noticias policiales con IA en ${medio.nombre}...`)
    const linksNoticias = await identificarNoticiasConIA(snapshot, medio.nombre)

    log('🔗', `${linksNoticias.length} noticias policiales identificadas en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias policiales en ${medio.nombre}`)
      return []
    }

    log('🔗', `${linksNoticias.length} links de noticias encontrados en ${medio.nombre}`)

    if (linksNoticias.length === 0) {
      log('⚠️', `No se encontraron noticias. Snapshot preview:`)
      log('📝', snapshot.slice(0, 500))
      return []
    }

    // 4. Visitar cada noticia con Tab Isolation Pattern
    const linksAVisitar = linksNoticias.slice(0, 10)

    for (const link of linksAVisitar) {
      try {
        // Re-snapshot y buscar ref fresco por título
        const freshSnapshot = agentCmd('snapshot -i -c', 10000)
        const escapedTitulo = link.titulo.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const freshMatch = freshSnapshot.match(new RegExp(`"${escapedTitulo}.*?\\[ref=(e\\d+)\\]`))
        const currentRef = freshMatch ? freshMatch[1] : link.ref

        // Abrir en tab nueva (tab 0 queda intacta)
        agentCmd(`click @${currentRef} --new-tab`)
        await new Promise(r => setTimeout(r, 2000)) // Esperar navegación

        // Cambiar a tab 1 (la del detalle)
        agentCmd('tab 1')
        agentCmd('wait --load networkidle', 10000)

        // Obtener URL del artículo
        const urlArticulo = agentCmd('get url')

        // Obtener título
        const titulo = agentCmd('get title') || link.titulo

        // Extraer texto con selectores comunes
        let texto = ''
        const selectoresContenido = [
          'article',
          '[data-component="article-body"]',
          '.article-body',
          '.article-text',
          '.nota-cuerpo',
          '.entry-content',
          '.story-body',
          '.content-body',
          '.article__body',
          '#article-content',
          '.body-article',
          'main article',
          '.detail-body',
          '.news-body',
        ]

        for (const selector of selectoresContenido) {
          texto = agentCmd(`get text "${selector}"`, 5000)
          if (texto && texto.length > 100) break
        }

        // Fallback: snapshot compacto de main
        if (!texto || texto.length < 100) {
          const snapMain = agentCmd('snapshot -s "main" -c', 5000)
          if (snapMain && snapMain.length > 100) {
            texto = snapMain.slice(0, 5000)
          }
        }

        // Cerrar tab de detalle, volver a tab 0
        agentCmd('tab close')
        await new Promise(r => setTimeout(r, 500))
        agentCmd('tab 0')
        await new Promise(r => setTimeout(r, 500))

        if (titulo && texto && texto.length > 80) {
          noticias.push({
            titulo: titulo.trim(),
            texto: texto.trim().slice(0, 5000),
            url: urlArticulo || '',
            medio: medio.nombre,
            medioTipo: medio.tipo ?? (medio.provincia && medio.provincia !== 'Nacional' ? 'provincial' : 'nacional'),
            provinciaOrigen: medio.provincia,
          })
          log('✅', `  ${titulo.slice(0, 60)}...`)
        } else {
          log('⏭️', `  Texto insuficiente: ${link.titulo.slice(0, 40)}`)
        }

      } catch (error) {
        log('⚠️', `Error en noticia: ${String(error).slice(0, 100)}`)
        // Intentar recuperar: cerrar tabs extras y volver a tab 0
        try {
          agentCmd('tab close')
          agentCmd('tab 0')
        } catch (_e2) { /* ignorar */ }
      }

      // Rate limiting entre noticias
      await new Promise(r => setTimeout(r, 2000))
    }

    log('📊', `${medio.nombre}: ${noticias.length} noticias extraídas`)

    return noticias

  } catch (error) {
    log('❌', `Error general en ${medio.nombre}: ${String(error).slice(0, 150)}`)
  }

  return noticias
}

// ════════════════════════════════════════════
// GEORREFERENCIACIÓN
// ════════════════════════════════════════════

async function georreferenciar(
  provincia: string | null,
  ciudad: string | null,
): Promise<{ provinciaId: string; latitud: number; longitud: number } | null> {
  if (!provincia) return null

  try {
    const resProv = await fetch(
      `https://apis.datos.gob.ar/georef/api/provincias?nombre=${encodeURIComponent(provincia)}&max=1`
    )
    const dataProv = await resProv.json()
    const prov = dataProv.provincias?.[0]

    if (!prov) return null

    // Si hay ciudad, buscar departamento para mejor precisión
    if (ciudad) {
      const resDep = await fetch(
        `https://apis.datos.gob.ar/georef/api/departamentos?nombre=${encodeURIComponent(ciudad)}&provincia=${prov.id}&max=1`
      )
      const dataDep = await resDep.json()
      const dep = dataDep.departamentos?.[0]

      if (dep?.centroide) {
        return {
          provinciaId: prov.id,
          latitud: dep.centroide.lat,
          longitud: dep.centroide.lon,
        }
      }
    }

    // Fallback: centroide de la provincia
    if (prov.centroide) {
      return {
        provinciaId: prov.id,
        latitud: prov.centroide.lat,
        longitud: prov.centroide.lon,
      }
    }

    return null
  } catch (_e) {
    log('⚠️', `Error georreferenciando ${provincia}/${ciudad}`)
    return null
  }
}

// ════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════

async function main() {
  log('🚀', 'Pipeline de Medios Periodísticos')
  log('⚙️', `Modo: ${DRY_RUN ? '🔍 DRY RUN' : '💾 ESCRITURA REAL'}`)
  log('⚙️', `Máximo noticias por medio: ${MAX_NOTICIAS}`)
  log('⚙️', `Confianza mínima: ${CONFIANZA_MINIMA}%`)

  // Verificar que agent-browser está instalado
  const versionAB = agentCmd('--version', 5000)
  if (!versionAB) {
    log('❌', 'agent-browser no está instalado o no responde')
    log('💡', 'Instalar con: npm install -g agent-browser && agent-browser install')
    process.exit(1)
  }
  log('✅', `agent-browser ${versionAB}`)

  // Pre-warm del daemon (solo una vez al inicio)
  let yaPrewarmed = false
  if (!yaPrewarmed) {
    yaPrewarmed = prewarmDaemon()
    if (!yaPrewarmed) {
      log('❌', 'No se pudo iniciar agent-browser. Saliendo.')
      process.exit(1)
    }
  }

  // Filtrar medios — excluir inactivos (paywall) salvo que se pida uno explícito
  const medios = MEDIO_ESPECIFICO
    ? MEDIOS.filter(m => m.id === MEDIO_ESPECIFICO)
    : MEDIOS.filter(m => m.activo !== false)

  if (medios.length === 0) {
    log('❌', `Medio "${MEDIO_ESPECIFICO}" no encontrado`)
    log('📋', 'Medios disponibles:', MEDIOS.map(m => m.id))
    process.exit(1)
  }

  log('📰', `Medios a scrapear: ${medios.map(m => m.nombre).join(', ')}`)

  // Obtener o crear fuente periodística
  let fuentePeriodistica = await prisma.fuente.findFirst({
    where: { nombre: 'Medios Periodísticos' }
  })

  if (!fuentePeriodistica) {
    fuentePeriodistica = await prisma.fuente.create({
      data: {
        nombre: 'Medios Periodísticos',
        tipo: 'PERIODISTICA',
        urlBase: 'https://openrouter.ai',
        frecuencia: 'diaria',
        confianzaDefault: 'PRELIMINAR',
        activa: true,
      }
    })
    log('📝', 'Fuente "Medios Periodísticos" creada')
  }

  // Cargar mapa de tipos de delito
  const tiposDelito = await prisma.tipoDelito.findMany()
  const tipoPorCodigo = new Map(tiposDelito.map(t => [t.codigoSnic, t]))

  // ── Estadísticas ──
  let totalScrapeadas = 0
  let totalExtraidas = 0
  let totalInsertadas = 0
  let totalVinculadas = 0
  let totalDuplicadas = 0
  let totalDescartadas = 0

  // ── Procesar cada medio ──
  for (const medio of medios) {
    log('', '─'.repeat(60))

    const noticiasRaw = await scrapearMedio(medio, yaPrewarmed)
    totalScrapeadas += noticiasRaw.length

    // Filtro homicidio: descartar antes de gastar tokens en OpenRouter
    const noticias = noticiasRaw.filter(n => {
      const tituloLower = n.titulo.toLowerCase()

      // 1. Descarte inmediato por título: droga/detención sin muerte → skip
      const tieneDescarte = PALABRAS_DESCARTE_INMEDIATO.some(p => tituloLower.includes(p))
      if (tieneDescarte) {
        const tieneMuerte = PALABRAS_CLAVE_HOMICIDIO.some(p => tituloLower.includes(p))
        if (!tieneMuerte) return false
      }

      // 2. Filtro positivo: título + inicio del texto debe tener indicador de muerte
      // 800 chars: el snapshot de accesibilidad empieza con navegación, el artículo aparece después
      const textoLower = (tituloLower + ' ' + n.texto.slice(0, 800).toLowerCase())
      return PALABRAS_CLAVE_HOMICIDIO.some(p => textoLower.includes(p))
    })

    for (const n of noticiasRaw) {
      if (!noticias.includes(n)) {
        log('⏭️', `Sin indicadores de muerte: "${n.titulo.slice(0, 60)}" — ${n.url}`)
        totalDescartadas++
      }
    }

    for (const noticia of noticias) {

      // ── Extracción IA ──
      log('🤖', `Extrayendo datos de: ${noticia.titulo.slice(0, 60)}...`)
      const datos = await extraerDatosNoticia(noticia.texto, noticia.url)

      if (!datos.esHechoDelictivo) {
        log('⏭️', `No es hecho delictivo: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      if (datos.confianzaExtraccion < CONFIANZA_MINIMA) {
        log('⏭️', `Confianza baja (${datos.confianzaExtraccion}%): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      if (datos.codigoSnicEstimado !== null &&
          ![0, 1, 2, 3, 4].includes(datos.codigoSnicEstimado)) {
        log('⏭️', `Código SNIC inválido para homicidios: ${datos.codigoSnicEstimado} — "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      totalExtraidas++

      // ── Deduplicación inteligente ──
      const dedup = await deduplicar({
        tipoHecho: datos.tipoHecho || '',
        codigoSnicEstimado: datos.codigoSnicEstimado ? String(datos.codigoSnicEstimado) : '',
        ubicacion: datos.ubicacion,
        fecha: datos.fecha,
        titulo: noticia.titulo,
        resumen: datos.descripcionBreve,
        medio: noticia.medio,
        medioTipo: noticia.medioTipo,
        url: noticia.url,
      })

      if (dedup.urlDuplicada) {
        log('⏭️', `URL ya procesada: ${noticia.url.slice(0, 50)}`)
        totalDuplicadas++
        continue
      }

      // ── Georreferenciación ──
      const provinciaParaGeoref = datos.ubicacion.provincia || noticia.provinciaOrigen || null
      const geo = await georreferenciar(provinciaParaGeoref, datos.ubicacion.ciudad)

      if (!geo) {
        log('⚠️', `No se pudo georreferenciar (${provinciaParaGeoref}): "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      // Mapear tipo de delito — sin default, el LLM debe asignar código
      const tipoDelito = datos.codigoSnicEstimado
        ? tipoPorCodigo.get(String(datos.codigoSnicEstimado))
        : null

      if (!tipoDelito) {
        log('⚠️', `Código SNIC ${datos.codigoSnicEstimado ?? 'null'} no mapeado: "${noticia.titulo.slice(0, 60)}" — ${noticia.url}`)
        totalDescartadas++
        continue
      }

      // Parsear fecha
      let fechaHecho: Date
      try {
        fechaHecho = datos.fecha ? new Date(datos.fecha) : new Date()
        if (isNaN(fechaHecho.getTime())) fechaHecho = new Date()
      } catch (_e) {
        fechaHecho = new Date()
      }

      // ── DRY RUN: solo mostrar ──
      if (DRY_RUN) {
        log('🔍', `[DRY RUN] ${dedup.esNuevo ? 'NUEVO' : 'COBERTURA'}: ${datos.tipoHecho} | SNIC:${datos.codigoSnicEstimado} | ${provinciaParaGeoref} | confianza:${datos.confianzaExtraccion}% | revision:${datos.requiereRevision ? '⚠️ SI' : 'no'} | ${noticia.url}`)
        if (dedup.esNuevo) totalInsertadas++
        else totalVinculadas++
        continue
      }

      /*
       * MIGRACIÓN REQUERIDA antes de activar requiereRevision en producción:
       *
       * ALTER TABLE hechos_delictivos
       *   ADD COLUMN IF NOT EXISTS requiere_revision BOOLEAN NOT NULL DEFAULT false;
       *
       * CREATE INDEX IF NOT EXISTS idx_hechos_requiere_revision
       *   ON hechos_delictivos (requiere_revision)
       *   WHERE requiere_revision = true;
       */

      // ── INSERCIÓN REAL ──
      if (dedup.esNuevo) {
        // CASO A: Hecho nuevo → HechoDelictivo + primera CoberturaMediatica
        log('🆕', `Hecho NUEVO (${dedup.confianza}%): ${noticia.titulo.slice(0, 50)}`)

        // Buscar o crear ubicación
        let ubicacion = await prisma.ubicacion.findFirst({
          where: { provinciaId: geo.provinciaId, latitud: geo.latitud, longitud: geo.longitud }
        })

        if (!ubicacion) {
          ubicacion = await prisma.ubicacion.create({
            data: {
              provincia: provinciaParaGeoref || 'Desconocida',
              provinciaId: geo.provinciaId,
              departamento: datos.ubicacion.ciudad,
              localidad: datos.ubicacion.barrio,
              direccion: datos.ubicacion.direccion,
              latitud: geo.latitud,
              longitud: geo.longitud,
              esCentroide: !datos.ubicacion.ciudad,
            }
          })
        }

        const hecho = await prisma.hechoDelictivo.create({
          data: {
            tipoDelitoId: tipoDelito.id,
            fechaHecho: fechaHecho,
            anio: fechaHecho.getFullYear(),
            mes: fechaHecho.getMonth() + 1,
            ubicacionId: ubicacion.id,
            cantidadVictimas: datos.cantidadVictimas || 1,
            cantidadHechos: 1,
            medioUtilizado: datos.medioUtilizado,
            fuenteId: fuentePeriodistica!.id,
            confianza: 'PRELIMINAR',
            urlFuente: noticia.url,
            esAgregado: false,
            esCasoUsina: false,
            requiereRevision: datos.requiereRevision ?? false,
          }
        })

        await prisma.coberturaMediatica.create({
          data: {
            hechoDelictivoId: hecho.id,
            medio: noticia.medio,
            medioTipo: noticia.medioTipo,
            titulo: noticia.titulo,
            url: noticia.url,
            fechaPublicacion: new Date(),
            resumen: datos.descripcionBreve,
            tipoCobertura: 'HECHO_INICIAL',
          }
        })

        totalInsertadas++

      } else {
        // CASO B: Cobertura de hecho existente → solo CoberturaMediatica
        log('📎', `Cobertura existente (${dedup.razon}): ${noticia.titulo.slice(0, 50)}`)

        const tipoCobertura = clasificarCobertura(noticia.titulo, noticia.texto)

        await prisma.coberturaMediatica.create({
          data: {
            hechoDelictivoId: dedup.hechoDelictivoId!,
            medio: noticia.medio,
            medioTipo: noticia.medioTipo,
            titulo: noticia.titulo,
            url: noticia.url,
            fechaPublicacion: new Date(),
            resumen: datos.descripcionBreve,
            tipoCobertura: tipoCobertura as 'HECHO_INICIAL' | 'ACTUALIZACION' | 'DETENCION' | 'MARCHA_RECLAMO' | 'PROCESO_JUDICIAL' | 'SENTENCIA' | 'ANIVERSARIO' | 'OPINION_EDITORIAL',
          }
        })

        // Promover a VERIFICADO si 3+ coberturas
        const totalCoberturas = await prisma.coberturaMediatica.count({
          where: { hechoDelictivoId: dedup.hechoDelictivoId! }
        })

        if (totalCoberturas >= 3) {
          await prisma.hechoDelictivo.update({
            where: { id: dedup.hechoDelictivoId! },
            data: { confianza: 'VERIFICADO' }
          })
          log('✅', `Hecho promovido a VERIFICADO (${totalCoberturas} coberturas)`)
        }

        totalVinculadas++
      }

      // Rate limiting entre llamadas a OpenRouter
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  // Cerrar browser al final
  agentCmd('close')

  // ── Resumen final ──
  log('', '═'.repeat(60))
  log('🎉', 'Pipeline completado')
  log('📊', 'Resumen:', {
    noticiasScrapeadas: totalScrapeadas,
    hechosExtraidos: totalExtraidas,
    hechosNuevos: totalInsertadas,
    coberturasVinculadas: totalVinculadas,
    duplicados: totalDuplicadas,
    descartados: totalDescartadas,
    modo: DRY_RUN ? 'DRY RUN' : 'PRODUCCIÓN',
  })

  // Actualizar fecha de la fuente
  if (!DRY_RUN && (totalInsertadas > 0 || totalVinculadas > 0)) {
    await prisma.fuente.update({
      where: { id: fuentePeriodistica!.id },
      data: { ultimaActualizacion: new Date() }
    })
  }
}

main()
  .catch(e => {
    log('❌', 'Error fatal:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())