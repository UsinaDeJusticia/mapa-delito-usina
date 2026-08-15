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

/** Directivas que NUNCA deben bloquear sin verificación contra el mapa real. */
const NO_PUEDEN_BLOQUEAR_TODAVIA = [
  'script-src',
  'connect-src',
  'img-src',
  'style-src',
  'worker-src',
  'font-src',
  'default-src',
  'form-action',
]

describe('la capa que bloquea es deliberadamente chica', () => {
  test('solo contiene las tres directivas seguras', () => {
    assert.deepEqual(
      Object.keys(ESTRICTAS).sort(),
      ['base-uri', 'frame-ancestors', 'object-src']
    )
  })

  test('ninguna directiva que pueda romper el mapa está bloqueando', () => {
    for (const directiva of NO_PUEDEN_BLOQUEAR_TODAVIA) {
      assert.ok(
        !(directiva in ESTRICTAS),
        `${directiva} pasó a modo bloqueo. Antes de esto hay que recolectar las ` +
        `violaciones reales con la política Report-Only sobre el mapa desplegado ` +
        `(ver las instrucciones en src/config/csp.mjs). Si ya se hizo, actualizá ` +
        `también este test explicando qué se verificó.`
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

  test('permite el worker de DuckDB, local y blob', () => {
    assert.deepEqual(OBSERVADAS['worker-src'], ["'self'", 'blob:'])
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
