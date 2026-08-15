/**
 * Destinos prohibidos para las peticiones que el pipeline hace hacia afuera.
 *
 * EL VECTOR REAL, que no es el que uno supondría
 * El pipeline no navega a URLs elegidas por el LLM. Abre la portada de cada
 * medio —una URL fija, de la config— y de ahí en más avanza haciendo CLICK en
 * links de la página (`comandos.clickNuevaTab`). El browser sigue adonde
 * apunte ese link, sin que nadie haya validado el destino.
 *
 * O sea: cualquiera que consiga poner un `<a href>` en la portada de alguno de
 * los ~45 medios —una nota patrocinada, un widget de terceros comprometido, un
 * comentario que renderice HTML— decide a qué URL se conecta nuestro servidor.
 * Y el contenido de la respuesta se extrae y se le manda al modelo.
 *
 * Los destinos que más importan:
 *   169.254.169.254   endpoint de metadatos de AWS/GCP/Azure: credenciales de
 *                     la instancia en texto plano
 *   127.0.0.1 / ::1   servicios que escuchan solo en loopback
 *   10/8, 172.16/12,  la red privada donde vive lo que no está expuesto
 *   192.168/16
 *
 * HASTA DÓNDE LLEGA ESTA DEFENSA — y hasta dónde no
 * Esto bloquea el destino que aparece EN LA URL. No resuelve DNS antes de
 * conectar, así que un dominio que resuelva a una IP privada
 * (`interno.ejemplo.com → 10.0.0.5`) pasa este filtro. Tampoco cubre DNS
 * rebinding, donde la resolución cambia entre la verificación y la conexión.
 *
 * Cerrar eso de verdad requiere control a nivel de red —una regla de egreso en
 * el runner que corre el pipeline— y no se puede hacer desde el código de la
 * aplicación. Esto es defensa en profundidad, no un perímetro: sube el costo y
 * corta el caso directo, que es el que se explota sin esfuerzo.
 */

export class DestinoProhibidoError extends Error {
  constructor(motivo: string) {
    super(`Destino no permitido: ${motivo}`)
    this.name = 'DestinoProhibidoError'
  }
}

const ESQUEMAS_PERMITIDOS = new Set(['http:', 'https:'])

/** Nombres que siempre apuntan a la propia máquina o a la red interna. */
const HOSTNAMES_PROHIBIDOS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
])

/** Sufijos reservados para redes internas (RFC 6762, RFC 8375, uso de nube). */
const SUFIJOS_PROHIBIDOS = ['.localhost', '.local', '.internal', '.home.arpa']

/**
 * Convierte a los cuatro octetos de una IPv4, o null si no es una.
 *
 * Acepta las formas raras a propósito, porque son justamente las que se usan
 * para esquivar un filtro ingenuo: `2130706433`, `0x7f.1`, `0177.0.0.1` y
 * `127.1` son todas 127.0.0.1 para el resolver del sistema.
 */
export function octetosIPv4(hostname: string): [number, number, number, number] | null {
  const partes = hostname.split('.')
  if (partes.length === 0 || partes.length > 4) return null

  const numeros: number[] = []
  for (const parte of partes) {
    if (parte === '') return null
    let n: number
    if (/^0[xX][0-9a-fA-F]+$/.test(parte)) n = parseInt(parte, 16)
    else if (/^0[0-7]+$/.test(parte)) n = parseInt(parte, 8)
    else if (/^\d+$/.test(parte)) n = parseInt(parte, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    numeros.push(n)
  }

  // Formas cortas: la última parte ocupa los octetos que faltan.
  // 127.1 → 127.0.0.1 ; 2130706433 → 127.0.0.1
  const ultima = numeros[numeros.length - 1]
  const previas = numeros.slice(0, -1)
  const relleno = 4 - previas.length
  if (ultima >= 256 ** relleno) return null
  if (previas.some(n => n > 255)) return null

  const octetos = [...previas]
  for (let i = relleno - 1; i >= 0; i--) {
    octetos.push((ultima >> (8 * i)) & 0xff)
  }
  return octetos as [number, number, number, number]
}

/** ¿Esta IPv4 cae en un rango que nunca debería alcanzarse desde el pipeline? */
export function esIPv4Reservada(octetos: [number, number, number, number]): boolean {
  const [a, b] = octetos
  return (
    a === 0 ||                                  // 0.0.0.0/8   "esta red"
    a === 10 ||                                 // 10/8        privada
    a === 127 ||                                // 127/8       loopback
    (a === 100 && b >= 64 && b <= 127) ||       // 100.64/10   CGNAT
    (a === 169 && b === 254) ||                 // 169.254/16  link-local Y METADATOS DE NUBE
    (a === 172 && b >= 16 && b <= 31) ||        // 172.16/12   privada
    (a === 192 && b === 0) ||                   // 192.0.0/24  asignaciones IETF
    (a === 192 && b === 168) ||                 // 192.168/16  privada
    (a === 198 && (b === 18 || b === 19)) ||    // 198.18/15   benchmarking
    a >= 224                                    // 224/4 multicast, 240/4 reservada
  )
}

/**
 * ¿Esta IPv6 es loopback, link-local o de uso interno?
 *
 * Acepta el hostname con o sin corchetes: `new URL('http://[::1]/').hostname`
 * devuelve `"[::1]"` CON corchetes, a diferencia de lo que uno esperaría.
 */
export function esIPv6Reservada(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  // IPv4 embebida. Hay que contemplar las dos escrituras porque el navegador y
  // Node normalizan a la segunda: `::ffff:169.254.169.254` se guarda como
  // `::ffff:a9fe:a9fe`. Un filtro que solo mire la forma con puntos se saltea
  // justo el caso que llega en la práctica.
  const conPuntos = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (conPuntos) {
    const octetos = octetosIPv4(conPuntos[1])
    if (octetos) return esIPv4Reservada(octetos)
  }

  const enHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (enHex) {
    const alto = parseInt(enHex[1], 16)
    const bajo = parseInt(enHex[2], 16)
    const octetos: [number, number, number, number] = [
      (alto >> 8) & 0xff, alto & 0xff,
      (bajo >> 8) & 0xff, bajo & 0xff,
    ]
    return esIPv4Reservada(octetos)
  }

  if (h === '::' || h === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true   // fc00::/7  únicas locales
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true   // fe80::/10 enlace local
  return false
}

/**
 * Verifica que una URL apunte a un destino externo legítimo.
 * Lanza DestinoProhibidoError si no. Devuelve la URL normalizada.
 */
export function validarDestino(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DestinoProhibidoError('URL no parseable')
  }

  if (!ESQUEMAS_PERMITIDOS.has(parsed.protocol)) {
    throw new DestinoProhibidoError(`esquema ${parsed.protocol}`)
  }

  // Credenciales en la URL: http://usuario:clave@host. Se usan para confundir
  // sobre cuál es el host real y no tienen ningún uso legítimo acá.
  if (parsed.username || parsed.password) {
    throw new DestinoProhibidoError('la URL lleva credenciales embebidas')
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === '') {
    throw new DestinoProhibidoError('sin host')
  }

  if (HOSTNAMES_PROHIBIDOS.has(hostname)) {
    throw new DestinoProhibidoError(`host interno (${hostname})`)
  }
  if (SUFIJOS_PROHIBIDOS.some(s => hostname.endsWith(s))) {
    throw new DestinoProhibidoError(`sufijo reservado (${hostname})`)
  }

  // Ojo: `new URL(...).hostname` devuelve la IPv6 CON corchetes ("[::1]"),
  // no los quita. esIPv6Reservada los tolera.
  if (hostname.includes(':') && esIPv6Reservada(hostname)) {
    throw new DestinoProhibidoError(`IPv6 reservada (${hostname})`)
  }

  const octetos = octetosIPv4(hostname)
  if (octetos && esIPv4Reservada(octetos)) {
    throw new DestinoProhibidoError(`IP reservada (${octetos.join('.')})`)
  }

  return parsed.toString()
}

/** Igual que validarDestino pero devuelve un booleano, para filtrar listas. */
export function esDestinoPermitido(url: string): boolean {
  try {
    validarDestino(url)
    return true
  } catch {
    return false
  }
}
