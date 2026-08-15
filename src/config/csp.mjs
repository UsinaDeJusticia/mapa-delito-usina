/**
 * Content Security Policy del Mapa del Delito.
 *
 * Se despliega en DOS capas a propósito, y la separación importa:
 *
 *   CSP_ESTRICTA   → se envía como `Content-Security-Policy` (BLOQUEA).
 *                    Solo directivas que no pueden romper nada de esta app,
 *                    verificable por lectura: la app no usa <object>, <embed>,
 *                    <base>, ni se embebe en iframes.
 *
 *   CSP_OBSERVADA  → se envía como `Content-Security-Policy-Report-Only`
 *                    (NO bloquea, solo reporta en la consola del navegador).
 *                    Todo lo que toca cómo carga el mapa: script-src,
 *                    connect-src, img-src, worker-src.
 *
 * POR QUÉ NO VA TODO EN MODO BLOQUEO
 * Google Maps carga scripts, tiles e imágenes desde una lista de dominios que
 * Google cambia sin aviso, y DuckDB-WASM cae a jsDelivr si los archivos locales
 * no están. Una directiva de más deja el mapa en blanco para todos los
 * visitantes, y este entorno de desarrollo no tiene acceso de red al deploy ni
 * una API key real de Maps, así que NO PUDE verificar la política contra el
 * mapa funcionando. Enviarla en modo bloqueo sin esa verificación sería
 * apostar el producto a una lista de dominios escrita de memoria.
 *
 * Report-Only es la forma estándar de estrenar una CSP justamente por esto: se
 * recolectan las violaciones reales primero, se ajusta, y recién después se
 * bloquea.
 *
 * CÓMO PASAR CSP_OBSERVADA A MODO BLOQUEO (el paso que queda pendiente)
 *   1. Abrir el mapa desplegado con la consola del navegador abierta.
 *      Recorrer: modo SNIC, modo SAT, filtros, click en provincia, zoom hasta
 *      que carguen los departamentos, y el panel /admin.
 *   2. Anotar cada mensaje que empiece con
 *      "[Report Only] Refused to ..." — cada uno es un dominio que falta.
 *   3. Agregarlo a la directiva correspondiente de acá.
 *   4. Repetir hasta que no aparezca ninguno.
 *   5. Recién entonces mover esas directivas a CSP_ESTRICTA.
 */

/** Une directivas en el formato de header. */
function serializar(directivas) {
  return Object.entries(directivas)
    .map(([nombre, valores]) => (valores.length ? `${nombre} ${valores.join(' ')}` : nombre))
    .join('; ')
}

// ════════════════════════════════════════════
// CAPA 1 — BLOQUEA
// ════════════════════════════════════════════
//
// Cada una de estas se puede justificar por lectura del código:
//
//   object-src 'none'     La app no usa <object>, <embed> ni <applet>. Es un
//                         vector clásico de XSS y de contenido Flash/PDF
//                         inyectado; apagarlo no tiene contrapartida.
//   base-uri 'self'       La app no usa <base>. Un <base> inyectado reescribe
//                         TODAS las URLs relativas de la página, incluidos los
//                         fetch a /api/*, hacia un host del atacante.
//   frame-ancestors 'none' Anti-clickjacking. Es el equivalente moderno del
//                         X-Frame-Options: DENY que ya está más abajo; se
//                         mandan los dos porque no todos los navegadores
//                         honran el viejo.
//   form-action 'self'    NO está acá: el login con Google podría hacer un POST
//                         que redirige a accounts.google.com, y el trato de los
//                         redirects en form-action difiere entre navegadores.
//                         Va en la capa observada hasta confirmarlo.
const DIRECTIVAS_ESTRICTAS = {
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
}

// ════════════════════════════════════════════
// CAPA 2 — SOLO REPORTA
// ════════════════════════════════════════════

// Dominios de Google Maps, según la documentación de la Maps JavaScript API.
// La lista es amplia a propósito: los tiles y los íconos salen de varios hosts
// de Google y la lista cambia sin aviso.
const GOOGLE_MAPS_SCRIPTS = ['https://maps.googleapis.com', 'https://maps.gstatic.com']
const GOOGLE_MAPS_IMAGENES = [
  'https://maps.googleapis.com',
  'https://maps.gstatic.com',
  'https://*.googleapis.com',
  'https://*.gstatic.com',
  'https://*.google.com',
  'https://*.ggpht.com',
  'https://*.googleusercontent.com',
]

// DuckDB-WASM cae a jsDelivr cuando los archivos locales de /duckdb/ no están
// (ver el try/catch en src/hooks/useDuckDB.ts).
const DUCKDB_CDN = ['https://cdn.jsdelivr.net']

const DIRECTIVAS_OBSERVADAS = {
  'default-src': ["'self'"],

  // 'unsafe-inline' y 'unsafe-eval' no son un descuido:
  //  - Next.js inyecta scripts inline para hidratar (sin nonces por request
  //    no hay forma de evitarlo, y los nonces exigen renderizado dinámico en
  //    todas las páginas, que hoy son estáticas).
  //  - DuckDB-WASM necesita 'unsafe-eval' para compilar el módulo WebAssembly.
  // Aun con estas dos, la política sigue sirviendo: limita DE DÓNDE puede
  // venir un script, que es lo que corta la exfiltración a un host externo.
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...GOOGLE_MAPS_SCRIPTS, ...DUCKDB_CDN],

  // Tailwind y los estilos inline de infowindow-dom.ts (que setean el atributo
  // style de cada nodo) necesitan 'unsafe-inline' acá.
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],

  // data: es imprescindible: los marcadores circulares del mapa son SVG
  // embebidos como data URI (ver MarcadoresCirculares.tsx).
  'img-src': ["'self'", 'data:', 'blob:', ...GOOGLE_MAPS_IMAGENES],

  // 'self' cubre las rutas /api/* y los Parquet de /data/.
  'connect-src': ["'self'", ...GOOGLE_MAPS_SCRIPTS, ...DUCKDB_CDN],

  // El worker de DuckDB: local ('self') o, en el fallback a CDN, un blob.
  'worker-src': ["'self'", 'blob:'],

  'media-src': ["'none'"],
  'manifest-src': ["'self'"],

  // Ver la nota de form-action arriba: acá se observa antes de bloquear.
  'form-action': ["'self'"],
  'frame-src': ["'none'"],
}

export const CSP_ESTRICTA = serializar(DIRECTIVAS_ESTRICTAS)
export const CSP_OBSERVADA = serializar(DIRECTIVAS_OBSERVADAS)

// Exportadas para los tests, que verifican el contenido y no solo el string.
export const _DIRECTIVAS_ESTRICTAS = DIRECTIVAS_ESTRICTAS
export const _DIRECTIVAS_OBSERVADAS = DIRECTIVAS_OBSERVADAS
