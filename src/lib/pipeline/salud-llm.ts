/**
 * Salud del proveedor LLM a lo largo de una corrida.
 *
 * POR QUÉ EXISTE
 * Del 7 al 24/9/2026 las corridas diarias fallaron en TODAS sus llamadas al
 * LLM (OpenCode Go empezó a exigir el header x-opencode-session) y todas
 * terminaron en verde. Cada consumidor degradaba bien de a una noticia —"sin
 * respuesta usable, 0 noticias en este medio"— pero nadie miraba el agregado:
 * 13 medios de 13 sin una sola respuesta es un proveedor caído, no un día
 * tranquilo. Ya estaba anotado como pendiente (docs/pendientes-y-features.md,
 * 1.8) desde el review del PR #10.
 *
 * Este monitor cuenta resultados por LLAMADA (no por intento: los reintentos
 * de obtenerContenidoLLM ya pasaron cuando llega acá) y le dice al pipeline
 * cuándo cortar.
 */

export interface ErrorProveedor {
  /** Código HTTP si el proveedor respondió; null si ni siquiera hubo respuesta. */
  status: number | null
  mensaje: string
}

/**
 * "400 Request is missing..." sin repetir el código: los errores del SDK de
 * OpenAI ya empiezan con el status, y anteponerlo otra vez daba "400 400 ...".
 */
export function describirErrorProveedor(status: number | null, mensaje: string): string {
  if (status === null) return `sin respuesta: ${mensaje}`
  return mensaje.startsWith(String(status)) ? mensaje : `${status} ${mensaje}`
}

export interface ResumenSaludLLM {
  llamadas: number
  exitos: number
  fallosProveedor: number
  fallosContenido: number
  ultimoError: ErrorProveedor | null
}

/**
 * Tres llamadas seguidas rechazadas por el proveedor ya no es una nota rara:
 * un 400 puntual puede deberse al contenido de UNA nota, tres seguidas sobre
 * notas y medios distintos es sistémico.
 */
export const UMBRAL_FALLOS_PROVEEDOR = 3

/**
 * Llamadas seguidas en las que el proveedor sí respondió pero nunca con algo
 * usable. Más alto porque cada una ya viene de 3 intentos: 8 llamadas son 24
 * respuestas inservibles al hilo.
 */
export const UMBRAL_SIN_EXITO = 8

export class MonitorSaludLLM {
  private llamadas = 0
  private exitos = 0
  private fallosProveedor = 0
  private fallosContenido = 0
  private consecutivosProveedor = 0
  private consecutivosSinExito = 0
  private ultimoError: ErrorProveedor | null = null

  constructor(
    private readonly umbralProveedor = UMBRAL_FALLOS_PROVEEDOR,
    private readonly umbralSinExito = UMBRAL_SIN_EXITO
  ) {}

  registrarExito(): void {
    this.llamadas++
    this.exitos++
    this.consecutivosProveedor = 0
    this.consecutivosSinExito = 0
  }

  /** El proveedor rechazó la request o no respondió. */
  registrarFalloProveedor(error: ErrorProveedor): void {
    this.llamadas++
    this.fallosProveedor++
    this.consecutivosProveedor++
    this.consecutivosSinExito++
    this.ultimoError = error
  }

  /** El proveedor respondió, pero vacío o con algo que no sirve. */
  registrarFalloContenido(): void {
    this.llamadas++
    this.fallosContenido++
    // Respondió: el proveedor está vivo, así que la racha de rechazos se corta.
    this.consecutivosProveedor = 0
    this.consecutivosSinExito++
  }

  /** Motivo para cortar la corrida, o null si se puede seguir. */
  motivoParaAbortar(): string | null {
    if (this.consecutivosProveedor >= this.umbralProveedor) {
      const e = this.ultimoError
      const detalle = e ? ` — último error: ${describirErrorProveedor(e.status, e.mensaje)}` : ''
      return `${this.consecutivosProveedor} llamadas seguidas rechazadas por el proveedor LLM${detalle}`
    }
    if (this.consecutivosSinExito >= this.umbralSinExito) {
      return `${this.consecutivosSinExito} llamadas seguidas al LLM sin una sola respuesta usable`
    }
    return null
  }

  /** true si hubo llamadas y ninguna salió bien: la corrida no produjo nada confiable. */
  sinNingunExito(): boolean {
    return this.llamadas > 0 && this.exitos === 0
  }

  resumen(): ResumenSaludLLM {
    return {
      llamadas: this.llamadas,
      exitos: this.exitos,
      fallosProveedor: this.fallosProveedor,
      fallosContenido: this.fallosContenido,
      ultimoError: this.ultimoError,
    }
  }
}

/** Instancia del proceso. Los tests crean la suya. */
export const saludLLM = new MonitorSaludLLM()
