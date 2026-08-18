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
  | 'no_es_homicidio'

export interface EfectoClasificacion {
  /** Código SNIC a asignar, o null si la clasificación dice que no es homicidio. */
  snicCodigo: number | null
  /** Si el hecho queda marcado como femicidio (hechos_delictivos.femicidio). */
  esFemicidio: boolean
}

/**
 * NOTA — 'violencia_policial' existe como valor válido en el CHECK constraint
 * de revisiones_pipeline (ver scripts/sql/create-revisiones-pipeline.sql) pero
 * no tiene botón en /admin/revisiones ni entrada acá: es un gap real y
 * separado, no alcanzado por este cambio. Si llegara ese valor (solo posible
 * escribiendo directo en la base), cae en el fallback de abajo y se trata
 * como "no es homicidio" — mismo comportamiento que tenía route.ts antes de
 * este archivo, así que no se está cambiando nada para ese caso.
 */
const EFECTOS: Record<string, EfectoClasificacion> = {
  homicidio_doloso:                     { snicCodigo: 1, esFemicidio: false },
  homicidio_en_ocasion_de_robo:         { snicCodigo: 1, esFemicidio: false },
  femicidio:                            { snicCodigo: 1, esFemicidio: true },
  homicidio_vinculado_al_narcotrafico:  { snicCodigo: 1, esFemicidio: false },
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
