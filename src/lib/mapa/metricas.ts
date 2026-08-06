/**
 * Métricas que distinguen "no hay dato" de "el dato es cero".
 *
 * EL PROBLEMA QUE RESUELVE
 * `estadisticas_agregadas.cantidad_victimas` es nullable, y buena parte de las
 * filas del SNIC no traen el conteo de víctimas: el organismo publicó los hechos
 * pero no las víctimas. Cuando `SUM(cantidad_victimas)` no encuentra ningún valor
 * devuelve NULL, y el código hacía `Number(null)` → `0`.
 *
 * Así, el mapa afirmaba "0 víctimas" en provincias donde en realidad no se sabe
 * cuántas hubo. Para una organización de derechos de víctimas de homicidio eso no
 * es un redondeo: es publicar que no hubo víctimas donde sí las hubo.
 *
 * LA REGLA
 * `null` significa "no hay dato" y se muestra como tal. `0` significa "se midió y
 * fue cero". Nunca se convierte uno en el otro. Un agregado de valores donde
 * algunos faltan es *parcial*, y se dice.
 */

/** Texto único para "no hay dato". Un solo lugar para cambiarlo. */
export const SIN_DATO = 'sin dato'

/** Marca que un total suma solo parte de los valores porque el resto falta. */
export const PARCIAL = 'parcial'

/**
 * Convierte a número preservando la ausencia de dato.
 *
 * Postgres devuelve los enteros grandes como BigInt y los agregados vacíos como
 * NULL. `Number(null)` es 0 y `Number(undefined)` es NaN; ninguno de los dos
 * sirve, así que ambos se mapean a null.
 */
export function numeroONull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  // `Number([])` es 0 y `Number([7])` es 7: un array vacío se colaría como un
  // cero inventado, que es justo lo que este módulo existe para evitar. Solo se
  // aceptan primitivas numéricas (number, bigint) o strings numéricos.
  if (typeof v === 'object') return null
  if (typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Suma dos valores que pueden faltar.
 *
 * Sumar null como 0 sería exactamente el error que este módulo evita, así que:
 * null + null = null (nadie aportó dato), y null + n = n con la salvedad de que
 * el resultado queda incompleto — de eso se ocupa `agregarMetrica`, que además
 * cuenta cuántos faltaron.
 */
export function sumarConDato(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

export interface Agregado {
  /** Suma de los valores presentes, o null si no había ninguno. */
  valor: number | null
  /** Cuántos valores aportaron dato. */
  conDato: number
  /** Cuántos no lo tenían. Si es > 0 y valor no es null, el total es parcial. */
  sinDato: number
}

/** Un total al que le faltan sumandos no es el total. */
export function esParcial(a: Agregado): boolean {
  return a.valor !== null && a.sinDato > 0
}

/** Suma una serie de valores reportando cuántos faltaban. */
export function agregarMetrica(valores: Array<number | null | undefined>): Agregado {
  let valor: number | null = null
  let conDato = 0
  let sinDato = 0

  for (const v of valores) {
    const n = v === undefined ? null : v
    if (n === null) {
      sinDato++
      continue
    }
    conDato++
    valor = (valor ?? 0) + n
  }

  return { valor, conDato, sinDato }
}

/**
 * Formatea una métrica para mostrarla.
 *
 * Devuelve el número con separadores de miles argentinos, o SIN_DATO. Nunca
 * devuelve '0' para un valor ausente.
 */
export function formatearMetrica(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return SIN_DATO
  return v.toLocaleString('es-AR')
}

/** Formatea un agregado, avisando cuando el total está incompleto. */
export function formatearAgregado(a: Agregado): string {
  if (a.valor === null) return SIN_DATO
  const base = a.valor.toLocaleString('es-AR')
  return esParcial(a) ? `${base} (${PARCIAL})` : base
}

/**
 * Explicación de por qué un total está incompleto, para un tooltip.
 * Devuelve null si no hay nada que aclarar.
 */
export function detalleParcial(a: Agregado, unidad = 'jurisdicciones'): string | null {
  if (a.valor === null) {
    return `La fuente no informa este dato para ninguna de las ${unidad} del período.`
  }
  if (a.sinDato === 0) return null
  const total = a.conDato + a.sinDato
  return (
    `Suma ${a.conDato} de ${total} ${unidad}: la fuente no informa este dato ` +
    `para las ${a.sinDato} restantes. El total real es mayor.`
  )
}

/**
 * Promedio que no inventa resultados.
 *
 * Sin numerador no hay promedio, y dividir por cero da Infinity —que se
 * renderizaría como "∞ víctimas por hecho"—, así que ambos casos caen a null.
 */
export function promedio(numerador: number | null, denominador: number | null): number | null {
  if (numerador === null || denominador === null || denominador === 0) return null
  const r = numerador / denominador
  return Number.isFinite(r) ? r : null
}

/** Formatea un promedio con dos decimales, o un guión si no se puede calcular. */
export function formatearPromedio(numerador: number | null, denominador: number | null): string {
  const r = promedio(numerador, denominador)
  return r === null ? '—' : r.toFixed(2)
}
