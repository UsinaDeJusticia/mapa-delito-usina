/**
 * Efecto de cada "clasificación humana" (los valores que llegan desde
 * /admin/revisiones) sobre los campos reales de hechos_delictivos.
 *
 * Antes esta tabla vivía SOLO en route.ts, y a la vez openrouter.ts leía
 * clasificacion_humana desde la base para armar ejemplos few-shot pero nunca
 * la traducía a nada concreto — el ejemplo que se le mandaba al modelo era un
 * JSON fijo, igual sin importar si el humano había marcado "femicidio",
 * "no es homicidio" o cualquier otra cosa. Un solo lugar evita que la
 * escritura en la base y la señal de aprendizaje diverjan entre sí.
 *
 * Femicidio no es un código SNIC propio: es un homicidio doloso (código 1)
 * marcado aparte en la columna hechos_delictivos.femicidio. El código 4 del
 * catálogo oficial es "Homicidios culposos por otros hechos" (negligencia
 * médica, accidentes laborales) — nunca femicidio.
 */

export type ClasificacionHumana =
  | 'homicidio_doloso'
  | 'homicidio_en_ocasion_de_robo'
  | 'femicidio'
  | 'homicidio_vinculado_al_narcotrafico'
  | 'violencia_policial'
  | 'no_es_homicidio'

export interface EfectoClasificacion {
  /** Código SNIC a asignar, o null si la clasificación dice que no es homicidio. */
  snicCodigo: number | null
  /** Si el hecho queda marcado como femicidio (hechos_delictivos.femicidio). */
  esFemicidio: boolean
}

/**
 * 'violencia_policial' va con código 1 (homicidio doloso). Una muerte por
 * violencia institucional es un homicidio, y el prompt del scraper ya la lista
 * como criterio de inclusión ("gatillo fácil").
 *
 * No hace falta una columna nueva en hechos_delictivos para no perder el matiz
 * de que fue institucional: `revisiones_pipeline.clasificacion_humana` guarda
 * el valor exacto para siempre y es consultable. Agregar una columna sería
 * duplicar un dato que ya existe.
 *
 * Antes esta clasificación no estaba acá y caía en el FALLBACK, o sea que se
 * trataba como "no es homicidio": el caso se degradaba a PRELIMINAR y se le
 * limpiaba la marca de femicidio. El valor ya era válido en el CHECK de
 * revisiones_pipeline, así que se podía guardar y quedaba mal interpretado.
 */
const EFECTOS: Record<string, EfectoClasificacion> = {
  homicidio_doloso:                     { snicCodigo: 1, esFemicidio: false },
  homicidio_en_ocasion_de_robo:         { snicCodigo: 1, esFemicidio: false },
  femicidio:                            { snicCodigo: 1, esFemicidio: true },
  homicidio_vinculado_al_narcotrafico:  { snicCodigo: 1, esFemicidio: false },
  violencia_policial:                   { snicCodigo: 1, esFemicidio: false },
  no_es_homicidio:                      { snicCodigo: null, esFemicidio: false },
}

const FALLBACK: EfectoClasificacion = { snicCodigo: null, esFemicidio: false }

export function efectoDeClasificacion(clasificacion: string): EfectoClasificacion {
  return EFECTOS[clasificacion] ?? FALLBACK
}

/** true si la clasificación implica que el hecho SÍ es un homicidio (algún código SNIC). */
export function esHomicidioSegunClasificacion(clasificacion: string): boolean {
  return efectoDeClasificacion(clasificacion).snicCodigo !== null
}
