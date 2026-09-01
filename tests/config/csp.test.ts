/**
 * Tests de la Content Security Policy.
 *
 * Lo que se protege acá no es "que exista una CSP" sino dos cosas concretas:
 *
 * 1. Que las directivas que SÍ bloquean sigan siendo solo las que no pueden
 *    romper la app. Si alguien mueve `script-src` a la capa estricta sin haber
 *    recolectado las violaciones reales primero, el mapa queda en blanco para
 *    todos los visitantes y el test lo frena antes.
 *
 * 2. Que la capa observada no pierda los permisos que el mapa necesita de
 *    verdad. Cada uno de los casos de abajo corresponde a algo verificable en
 *    el código: los marcadores son SVG en data: URI, DuckDB compila WASM y
 *    puede caer a jsDelivr, los InfoWindow setean el atributo style.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CSP_ESTRICTA,
  CSP_OBSERVADA,
  _DIRECTIVAS_ESTRICTAS as ESTRICTAS,
  _DIRECTIVAS_OBSERVADAS as OBSERVADAS,
} from '../../src/config/csp.mjs'

const RAIZ = process.cwd()

/**
 * Directivas que NUNCA deben bloquear sin datos reales de /api/csp-report:
 * dependen de una lista de dominios de terceros (Google Maps, jsDelivr) que
 * puede cambiar sin aviso, o de 'unsafe-inline'/'unsafe-eval' que hoy son
 * imprescindibles (hidratación de Next, DuckDB-WASM, estilos inline).
 */
const NO_PUEDEN_BLOQUEAR_TODAVIA = [
  'script-src',
  'connect-src',
  'img-src',
  'style-src',
  'font-src',
  'default-src',
  'form-action',
]

describe('la capa que bloquea trae solo lo verificable por lectura de código', () => {
  test('contiene exactamente las directivas ya verificadas', () => {
    assert.deepEqual(
      Object.keys(ESTRICTAS).sort(),
      ['base-uri', 'frame-ancestors', 'frame-src', 'media-src', 'object-src', 'report-uri', 'worker-src']
    )
  })

  test('ninguna directiva que dependa de dominios de terceros está bloqueando', () => {
    for (const directiva of NO_PUEDEN_BLOQUEAR_TODAVIA) {
      assert.ok(
        !(directiva in ESTRICTAS),
        `${directiva} pasó a modo bloqueo sin datos reales de /api/csp-report ` +
        `(ver las instrucciones en src/config/csp.mjs). Si ya se juntaron y se ` +
        `revisaron, actualizá también este test explicando qué se verificó.`
      )
    }
  })

  test('object-src y base-uri están cerrados', () => {
    assert.deepEqual(ESTRICTAS['object-src'], ["'none'"])
    assert.deepEqual(ESTRICTAS['base-uri'], ["'self'"])
  })

  test('frame-ancestors none acompaña al X-Frame-Options existente', () => {
    assert.deepEqual(ESTRICTAS['frame-ancestors'], ["'none'"])
    const config = readFileSync(path.join(RAIZ, 'next.config.mjs'), 'utf-8')
    assert.match(config, /X-Frame-Options/, 'el header viejo se mantiene para navegadores que no honran frame-ancestors')
  })

  test('worker-src, media-src y frame-src bloquean de verdad', () => {
    // Las tres se movieron acá sin pasar por Report-Only: no dependen de un
    // dominio de terceros, son verificables leyendo el código (ver el
    // comentario de arriba de DIRECTIVAS_ESTRICTAS en csp.mjs).
    assert.deepEqual(ESTRICTAS['worker-src'], ["'self'", 'blob:'])
    assert.deepEqual(ESTRICTAS['media-src'], ["'none'"])
    assert.deepEqual(ESTRICTAS['frame-src'], ["'none'"])
  })

  test('manda report-uri para dejar de perder las violaciones', () => {
    // Antes Report-Only mandaba las violaciones a la consola de cada
    // visitante y nadie las juntaba — "observar" no observaba nada.
    assert.deepEqual(ESTRICTAS['report-uri'], ['/api/csp-report'])
  })
})

describe('la capa observada no rompe lo que el mapa necesita', () => {
  test('permite los data: URI de los marcadores circulares', () => {
    // MarcadoresCirculares.tsx arma cada burbuja como un SVG embebido:
    // url: `data:image/svg+xml,${encodeURIComponent(svg)}`
    assert.ok(OBSERVADAS['img-src'].includes('data:'))
    const marcadores = readFileSync(
      path.join(RAIZ, 'src/components/mapa/capas/MarcadoresCirculares.tsx'),
      'utf-8'
    )
    assert.match(marcadores, /data:image\/svg\+xml/, 'si esto cambia, revisar img-src')
  })

  test("permite 'unsafe-eval', que DuckDB-WASM necesita para compilar", () => {
    assert.ok(
      OBSERVADAS['script-src'].includes("'unsafe-eval'"),
      'sin unsafe-eval, DuckDB no instancia el módulo WASM y el mapa pierde su camino por defecto'
    )
  })

  test('permite el CDN al que DuckDB cae si no están los archivos locales', () => {
    const hook = readFileSync(path.join(RAIZ, 'src/hooks/useDuckDB.ts'), 'utf-8')
    assert.match(hook, /getJsDelivrBundles/, 'el fallback a jsDelivr sigue en el código')
    for (const directiva of ['script-src', 'connect-src'] as const) {
      assert.ok(
        OBSERVADAS[directiva].includes('https://cdn.jsdelivr.net'),
        `${directiva} tiene que permitir jsDelivr mientras exista el fallback`
      )
    }
  })

  test("permite los estilos inline que arman los InfoWindow", () => {
    // infowindow-dom.ts hace el.setAttribute('style', ...) en cada nodo.
    assert.ok(OBSERVADAS['style-src'].includes("'unsafe-inline'"))
    const infowindow = readFileSync(
      path.join(RAIZ, 'src/lib/mapa/infowindow-dom.ts'),
      'utf-8'
    )
    assert.match(infowindow, /setAttribute\('style'/)
  })

  test('permite los dominios de Google Maps en script, img y connect', () => {
    assert.ok(OBSERVADAS['script-src'].includes('https://maps.googleapis.com'))
    assert.ok(OBSERVADAS['connect-src'].includes('https://maps.googleapis.com'))
    assert.ok(OBSERVADAS['img-src'].includes('https://maps.gstatic.com'))
  })

  test('no incluye Google Fonts: no hay ningún uso real detectado', () => {
    // El layout usa fuentes locales (next/font/local, GeistVF.woff). Estas dos
    // entradas estaban desde el origen de la CSP sin que nada las necesitara —
    // dejarlas ensancha la política sin motivo.
    assert.ok(!OBSERVADAS['style-src'].includes('https://fonts.googleapis.com'))
    assert.ok(!OBSERVADAS['font-src'].includes('https://fonts.gstatic.com'))
    const layout = readFileSync(path.join(RAIZ, 'src/app/layout.tsx'), 'utf-8')
    assert.ok(
      !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(layout),
      'si esto cambia (se agrega una Google Font real), hay que devolver el dominio a la CSP'
    )
  })

  test('también manda report-uri: las violaciones observadas no se pierden', () => {
    assert.deepEqual(OBSERVADAS['report-uri'], ['/api/csp-report'])
  })
})

describe('/api/csp-report recibe las violaciones sin romperse', () => {
  test('un reporte bien formado devuelve 204 y no lanza', async () => {
    const { POST } = await import('../../src/app/api/csp-report/route')
    const cuerpo = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://usina.example/mapa-del-delito',
        'violated-directive': 'script-src',
        'blocked-uri': 'https://evil.example/x.js',
      },
    })
    const respuesta = await POST(new Request('http://localhost/api/csp-report', { method: 'POST', body: cuerpo }))
    assert.equal(respuesta.status, 204)
  })

  test('un cuerpo malformado tampoco rompe la ruta', async () => {
    const { POST } = await import('../../src/app/api/csp-report/route')
    const respuesta = await POST(new Request('http://localhost/api/csp-report', { method: 'POST', body: 'no es json' }))
    assert.equal(respuesta.status, 204)
  })

  test('el límite de tamaño del cuerpo es chico de verdad, no un número simbólico', () => {
    // No es una ruta autenticada — cualquiera puede llamarla. Comprobar solo
    // que la constante EXISTE no alcanza: hay que verificar que su valor
    // realmente acota algo, o un "arreglo" que la deje en un número enorme
    // pasaría el test igual.
    const ruta = readFileSync(path.join(RAIZ, 'src/app/api/csp-report/route.ts'), 'utf-8')
    const m = ruta.match(/TAMANIO_MAXIMO\s*=\s*([\d_]+)/)
    assert.ok(m, 'falta el límite de tamaño del cuerpo')
    const valor = Number(m![1].replace(/_/g, ''))
    assert.ok(valor <= 100_000, `TAMANIO_MAXIMO=${valor} ya no acota nada — un reporte real pesa cientos de bytes`)
  })
})

describe('los headers salen bien formados', () => {
  test('las dos políticas serializan a un string no vacío', () => {
    assert.ok(CSP_ESTRICTA.length > 0)
    assert.ok(CSP_OBSERVADA.length > 0)
  })

  test('usan punto y coma como separador y no llevan salto de línea', () => {
    for (const politica of [CSP_ESTRICTA, CSP_OBSERVADA]) {
      assert.ok(politica.includes('; '), 'las directivas se separan con "; "')
      assert.ok(!politica.includes('\n'), 'un salto de línea rompe el header HTTP')
    }
  })

  test('ninguna directiva queda vacía', () => {
    for (const [nombre, valores] of Object.entries({ ...ESTRICTAS, ...OBSERVADAS })) {
      assert.ok(valores.length > 0, `${nombre} quedó sin valores`)
    }
  })

  test('next.config manda las dos, cada una con su header', () => {
    const config = readFileSync(path.join(RAIZ, 'next.config.mjs'), 'utf-8')
    assert.match(config, /'Content-Security-Policy',\s*value:\s*CSP_ESTRICTA/)
    assert.match(config, /'Content-Security-Policy-Report-Only',\s*value:\s*CSP_OBSERVADA/)
  })
})

describe('Permissions-Policy', () => {
  const config = readFileSync(path.join(RAIZ, 'next.config.mjs'), 'utf-8')

  test('deja la geolocalización, que el mapa usa', () => {
    // useGeolocalizacion.ts pide la posición del browser para centrar el mapa.
    assert.match(config, /geolocation=\(self\)/)
  })

  test('apaga cámara, micrófono, pagos y USB', () => {
    for (const api of ['camera=()', 'microphone=()', 'payment=()', 'usb=()']) {
      assert.ok(config.includes(api), `falta apagar ${api}`)
    }
  })
})
