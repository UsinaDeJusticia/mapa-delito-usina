/**
 * Fechas del pipeline en hora argentina.
 *
 * POR QUÉ EXISTE
 * El pipeline corría solo en GitHub Actions, en UTC, y ahora también corre en
 * una computadora del equipo con la zona de Argentina. El código hacía
 * `new Date('2026-09-01').getMonth() + 1`: en UTC da 9, en Argentina da 8,
 * porque la medianoche UTC son las 21 hs del día anterior. Un hecho del 1 de
 * enero quedaba con el año anterior. Todo lo que depende del día calendario
 * pasa por acá, y así da lo mismo dónde corra.
 */

export const ZONA_ARGENTINA = 'America/Argentina/Buenos_Aires'

const FORMATO_FECHA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_ARGENTINA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const FORMATO_HORA = new Intl.DateTimeFormat('es-AR', {
  timeZone: ZONA_ARGENTINA,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 'YYYY-MM-DD' del día en Argentina. */
export function fechaArgentina(ahora: Date = new Date()): string {
  return FORMATO_FECHA.format(ahora)
}

/**
 * 'HH:MM:SS' en Argentina, 24 horas. Para los logs: antes usaban
 * toLocaleTimeString('es-AR') con la zona de la máquina, y en Actions una
 * corrida de las 14:32 UTC quedaba anotada como "02:32:22".
 */
export function horaArgentina(ahora: Date = new Date()): string {
  return FORMATO_HORA.format(ahora)
}

/** Minutos transcurridos desde la medianoche en Argentina (0-1439). */
export function minutosDelDiaArgentina(ahora: Date = new Date()): number {
  const partes = FORMATO_HORA.formatToParts(ahora)
  const valor = (tipo: string) => Number(partes.find(p => p.type === tipo)?.value ?? 0)
  return (valor('hour') % 24) * 60 + valor('minute')
}

/**
 * Lo que se guarda para la fecha de un hecho: la fecha en sí (columna DATE) y
 * el año y mes que usan las consultas rápidas.
 *
 * @param fecha 'YYYY-MM-DD' ya validado por schemas-llm (o null si el modelo no
 *              pudo determinarlo, en cuyo caso se usa el día de hoy en Argentina).
 */
export function fechaDelHecho(
  fecha: string | null,
  ahora: Date = new Date()
): { fecha: Date; anio: number; mes: number } {
  const texto = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : fechaArgentina(ahora)
  const [anio, mes, dia] = texto.split('-').map(Number)
  // Medianoche UTC del día pedido: la columna es DATE y Prisma la serializa con
  // los componentes UTC, así que este Date se guarda exactamente como `texto`.
  return { fecha: new Date(Date.UTC(anio, mes - 1, dia)), anio, mes }
}
