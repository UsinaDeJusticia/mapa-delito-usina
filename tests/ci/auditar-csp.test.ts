/**
 * Auditoría de CSP — el script recolecta violaciones reales para decidir la
 * Fase F (qué directivas pasan de Report-Only a bloqueo). Si el parseo de
 * mensajes de consola es flojo, se sub-cuenta o se ignora una violación real y
 * la decisión se toma con datos incompletos — exactamente lo que este trabajo
 * quería evitar de "escribir la CSP de memoria".
 *
 * Todo se prueba con una `page` falsa inyectada: este entorno no tiene salida
 * a `*.vercel.app`, así que nunca se lanza un browser real acá.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parsearMensajeConsola,
  esRedirectALoginVercel,
  RegistradorViolaciones,
  directivasSinViolaciones,
  tablaViolaciones,
  generarReporte,
  recorrerSitio,
  type PaginaLike,
  type ResultadoAuditoria,
} from '../../scripts/ci/auditar-csp'
import { _DIRECTIVAS_OBSERVADAS } from '../../src/config/csp.mjs'

const RAIZ = process.cwd()

describe('parsearMensajeConsola distingue los formatos que emite Chrome', () => {
  test('bloqueo real de un script externo', () => {
    const texto =
      `Refused to load the script 'https://evil.example.com/x.js' because it violates the following ` +
      `Content Security Policy directive: "script-src 'self'". Note that 'script-src-elem' was not ` +
      `explicitly set, so 'script-src' is used as a fallback.`
    assert.deepEqual(parsearMensajeConsola(texto), {
      directiva: 'script-src',
      uri: 'https://evil.example.com/x.js',
    })
  })

  test('Report-Only con prefijo [Report Only] en connect-src', () => {
    const texto =
      `[Report Only] Refused to connect to 'https://api.example.com/data' because it violates the ` +
      `following Content Security Policy directive: "connect-src 'self'".`
    assert.deepEqual(parsearMensajeConsola(texto), {
      directiva: 'connect-src',
      uri: 'https://api.example.com/data',
    })
  })

  test('estilo inline sin URI — cae a "inline"', () => {
    const texto =
      `[Report Only] Refused to apply inline style because it violates the following Content Security ` +
      `Policy directive: "style-src 'self'". Either the 'unsafe-inline' keyword, a hash ('sha256-...'), ` +
      `or a nonce ('nonce-...') is required to enable inline execution.`
    assert.deepEqual(parsearMensajeConsola(texto), { directiva: 'style-src', uri: 'inline' })
  })

  test('script inline (sin comillas antes de "because")', () => {
    const texto =
      `Refused to execute inline script because it violates the following Content Security Policy ` +
      `directive: "script-src 'self'".`
    assert.deepEqual(parsearMensajeConsola(texto), { directiva: 'script-src', uri: 'inline' })
  })

  test('un mensaje de consola que no es de CSP se ignora', () => {
    assert.equal(parsearMensajeConsola('TypeError: cannot read properties of undefined'), null)
    assert.equal(parsearMensajeConsola('Failed to load resource: 404'), null)
    assert.equal(parsearMensajeConsola('Warning: algo de React'), null)
  })

  test('un "Refused to" que no es de CSP (permisos del navegador, no CSP) se ignora', () => {
    // Mismo verbo, otro mecanismo — sin "Content Security Policy directive"
    // no hay que contarlo como violación de CSP.
    assert.equal(
      parsearMensajeConsola("Refused to show a popup because it wasn't triggered by a user gesture."),
      null
    )
  })
})

describe('RegistradorViolaciones deduplica por (directiva, URI) y cuenta páginas', () => {
  test('la misma violación en dos páginas cuenta 2 veces y junta las páginas', () => {
    const r = new RegistradorViolaciones()
    r.registrar({ directiva: 'img-src', uri: 'https://x.com/a.png' }, '/mapa-del-delito')
    r.registrar({ directiva: 'img-src', uri: 'https://x.com/a.png' }, '/metodologia')

    const lista = r.lista()
    assert.equal(lista.length, 1)
    assert.equal(lista[0].veces, 2)
    assert.deepEqual(lista[0].paginas, ['/mapa-del-delito', '/metodologia'])
  })

  test('misma directiva, distinta URI → filas separadas', () => {
    const r = new RegistradorViolaciones()
    r.registrar({ directiva: 'script-src', uri: 'https://a.com/x.js' }, '/')
    r.registrar({ directiva: 'script-src', uri: 'https://b.com/y.js' }, '/')
    assert.equal(r.lista().length, 2)
  })

  test('repetir en la misma página también suma "veces"', () => {
    const r = new RegistradorViolaciones()
    r.registrar({ directiva: 'connect-src', uri: 'https://x.com' }, '/mapa-del-delito')
    r.registrar({ directiva: 'connect-src', uri: 'https://x.com' }, '/mapa-del-delito')
    const lista = r.lista()
    assert.equal(lista[0].veces, 2)
    assert.deepEqual(lista[0].paginas, ['/mapa-del-delito'])
  })
})

describe('directivasSinViolaciones usa el catálogo real de csp.mjs', () => {
  test('con cero violaciones, devuelve todas las directivas observadas', () => {
    const todas = Object.keys(_DIRECTIVAS_OBSERVADAS)
    assert.deepEqual(directivasSinViolaciones([]).sort(), [...todas].sort())
  })

  test('descuenta exactamente las directivas que aparecieron', () => {
    const r = new RegistradorViolaciones()
    r.registrar({ directiva: 'img-src', uri: 'https://x.com/a.png' }, '/')
    r.registrar({ directiva: 'font-src', uri: 'https://fonts.example.com/a.woff' }, '/')

    const limpias = directivasSinViolaciones(r.lista())
    const todas = Object.keys(_DIRECTIVAS_OBSERVADAS)

    assert.deepEqual(
      limpias.sort(),
      todas.filter(d => d !== 'img-src' && d !== 'font-src').sort()
    )
  })

  test('una directiva que ni siquiera está en csp.mjs no aparece como "limpia"', () => {
    // Si algún día se agrega una directiva rara al parseo que no existe en
    // CSP_OBSERVADA, no tiene que colarse en la lista de candidatas.
    const limpias = directivasSinViolaciones([])
    assert.equal(limpias.includes('no-existe-src'), false)
  })
})

describe('tablaViolaciones y generarReporte', () => {
  test('sin violaciones, el cuerpo lo dice explícitamente', () => {
    assert.match(tablaViolaciones([]), /Ninguna violación/)
  })

  test('con violaciones, arma una fila de markdown por cada una', () => {
    const tabla = tablaViolaciones([
      { directiva: 'img-src', uri: 'https://x.com/a.png', paginas: ['/mapa-del-delito'], veces: 3 },
    ])
    assert.match(tabla, /\| img-src \| `https:\/\/x\.com\/a\.png` \| \/mapa-del-delito \| 3 \|/)
  })

  test('el reporte pone el estado HTTP arriba de todo y marca alarma si no es 200', () => {
    const resultado: ResultadoAuditoria = {
      status: 500,
      redirigioALogin: false,
      urlFinal: 'https://mapa-delito-usina.vercel.app',
      pasos: [],
      adminUrlFinal: null,
      cspReportStatus: null,
    }
    const reporte = generarReporte(resultado, [], 'https://mapa-delito-usina.vercel.app')
    const indiceEstado = reporte.indexOf('🚨')
    const indiceTabla = reporte.indexOf('## Violaciones')
    assert.ok(indiceEstado >= 0 && indiceEstado < indiceTabla, 'la alarma de estado HTTP tiene que ir antes que la tabla')
    assert.match(reporte, /500/)
  })

  test('200 sin redirect se reporta como éxito, no como alarma', () => {
    const resultado: ResultadoAuditoria = {
      status: 200,
      redirigioALogin: false,
      urlFinal: 'https://mapa-delito-usina.vercel.app/',
      pasos: [],
      adminUrlFinal: '/admin/login',
      cspReportStatus: 204,
    }
    const reporte = generarReporte(resultado, [], 'https://mapa-delito-usina.vercel.app')
    assert.match(reporte, /✅ Estado HTTP/)
    assert.doesNotMatch(reporte, /🚨/)
  })

  test('lista exactamente las directivas de csp.mjs sin violaciones', () => {
    const resultado: ResultadoAuditoria = {
      status: 200,
      redirigioALogin: false,
      urlFinal: 'x',
      pasos: [],
      adminUrlFinal: null,
      cspReportStatus: null,
    }
    const violaciones = [{ directiva: 'img-src', uri: 'https://x.com', paginas: ['/'], veces: 1 }]
    const reporte = generarReporte(resultado, violaciones, 'x')
    for (const d of Object.keys(_DIRECTIVAS_OBSERVADAS)) {
      if (d === 'img-src') continue
      assert.match(reporte, new RegExp('`' + d + '`'), `debería listar ${d} como limpia`)
    }
    assert.doesNotMatch(reporte, /- `img-src`/)
  })
})

describe('esRedirectALoginVercel detecta la alarma del SSO', () => {
  test('vercel.com/login es una alarma', () => {
    assert.equal(esRedirectALoginVercel('https://vercel.com/login?next=%2F'), true)
  })

  test('un dominio de sso-api también', () => {
    assert.equal(esRedirectALoginVercel('https://mapa-delito-usina.vercel.app/sso-api?x=1'), true)
  })

  test('la home normal del sitio no es una alarma', () => {
    assert.equal(esRedirectALoginVercel('https://mapa-delito-usina.vercel.app/'), false)
  })
})

// ─── Página falsa mínima para probar recorrerSitio ──────────────────────────

interface PaginaFalsaOpts {
  urlBase: string
  statusBase?: number
  urlFinalTrasGoto?: string
  faltaGetByText?: boolean
  adminUrlFinal?: string
  cspReportStatus?: number
}

function crearPaginaFalsa(opts: PaginaFalsaOpts): PaginaLike {
  let urlActual = opts.urlFinalTrasGoto ?? opts.urlBase

  const gotos: string[] = []

  const pagina: PaginaLike = {
    async goto(url) {
      gotos.push(url)
      // Simula el redirect de Vercel/next-auth: cualquier goto a /admin
      // termina en adminUrlFinal si se especificó.
      if (url.includes('/admin') && opts.adminUrlFinal) {
        urlActual = opts.adminUrlFinal
      } else if (gotos.length === 1) {
        urlActual = opts.urlFinalTrasGoto ?? url
      } else {
        urlActual = url
      }
      return { status: () => (gotos.length === 1 ? opts.statusBase ?? 200 : 200) }
    },
    url() {
      return urlActual
    },
    async waitForTimeout() {},
    getByText(_texto, _o) {
      if (opts.faltaGetByText) {
        throw new Error('getByText no existe en esta página falsa')
      }
      return { async click() {} }
    },
    mouse: { async wheel() {} },
    keyboard: { async press() {} },
    async evaluate(_fn) {
      return opts.cspReportStatus ?? 204
    },
  }
  return pagina
}

describe('recorrerSitio', () => {
  test('un recorrido normal llega hasta /admin y /api/csp-report', async () => {
    const pagina = crearPaginaFalsa({
      urlBase: 'https://x.vercel.app',
      adminUrlFinal: 'https://x.vercel.app/admin/login',
      cspReportStatus: 204,
    })
    const resultado = await recorrerSitio(pagina, 'https://x.vercel.app')

    assert.equal(resultado.status, 200)
    assert.equal(resultado.redirigioALogin, false)
    assert.equal(resultado.adminUrlFinal, 'https://x.vercel.app/admin/login')
    assert.equal(resultado.cspReportStatus, 204)
    // Todos los pasos tienen que haber corrido (nada tumbó la corrida).
    assert.ok(resultado.pasos.length > 5)
    assert.ok(resultado.pasos.every(p => p.ok), 'ningún paso debería haber fallado en el caso feliz')
  })

  test('un selector inexistente (getByText) no tumba la corrida — se registra y sigue', async () => {
    const pagina = crearPaginaFalsa({
      urlBase: 'https://x.vercel.app',
      faltaGetByText: true,
      adminUrlFinal: 'https://x.vercel.app/admin/login',
    })
    const resultado = await recorrerSitio(pagina, 'https://x.vercel.app')

    // El recorrido completo sigue devolviendo un resultado coherente...
    assert.equal(resultado.status, 200)
    assert.equal(resultado.adminUrlFinal, 'https://x.vercel.app/admin/login')
    // ...y los pasos que dependían de getByText quedan marcados como fallidos,
    // no lanzan una excepción que aborte todo.
    const fallidos = resultado.pasos.filter(p => !p.ok)
    assert.ok(fallidos.length > 0, 'los pasos con getByText tendrían que haber fallado')
    assert.ok(fallidos.every(f => f.detalle && f.detalle.length > 0))
  })

  test('redirect a login de Vercel en la URL base corta el recorrido ahí (alarma)', async () => {
    const pagina = crearPaginaFalsa({
      urlBase: 'https://x.vercel.app',
      urlFinalTrasGoto: 'https://vercel.com/login?next=%2F',
    })
    const resultado = await recorrerSitio(pagina, 'https://x.vercel.app')

    assert.equal(resultado.redirigioALogin, true)
    assert.equal(resultado.adminUrlFinal, null, 'no debería seguir navegando tras detectar el login')
    assert.equal(resultado.cspReportStatus, null)
  })

  test('status distinto de 200 en la URL base se refleja en el resultado', async () => {
    const pagina = crearPaginaFalsa({ urlBase: 'https://x.vercel.app', statusBase: 500 })
    const resultado = await recorrerSitio(pagina, 'https://x.vercel.app')
    assert.equal(resultado.status, 500)
  })
})

describe('.github/workflows/auditar-csp.yml', () => {
  const YML = readFileSync(path.join(RAIZ, '.github/workflows/auditar-csp.yml'), 'utf-8')

  test('se dispara solo a mano — nunca en un schedule', () => {
    assert.match(YML, /workflow_dispatch:/)
    assert.doesNotMatch(YML, /\n\s*schedule:/, 'auditar-csp no debería tener trigger de schedule')
  })

  test('permisos de solo lectura', () => {
    assert.match(YML, /permissions:\s*\n\s*contents:\s*read/)
  })

  test('el input url tiene como default la URL de producción', () => {
    assert.match(YML, /url:/)
    assert.match(YML, /default:\s*['"]https:\/\/mapa-delito-usina\.vercel\.app['"]/)
  })

  test('vuelca el resultado con tee -a, no con >>, para que quede en los logs y en el summary', () => {
    assert.match(YML, /tee -a "\$GITHUB_STEP_SUMMARY"/)
    assert.doesNotMatch(
      YML,
      />>\s*"\$GITHUB_STEP_SUMMARY"/,
      'con >> el reporte solo queda en el summary, no en los logs grepeables'
    )
  })

  test('instala Chromium antes de correr el script', () => {
    assert.match(YML, /playwright install/)
  })
})
