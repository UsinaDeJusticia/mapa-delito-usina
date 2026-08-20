/**
 * El health-check de medios clasifica bien los fallos.
 *
 * POR QUÉ IMPORTA QUE CLASIFIQUE BIEN
 * El objetivo del script es que alguien decida, con datos, qué medio desactivar
 * y cuál activar. Si confunde "el dominio está muerto" con "esta página
 * renderiza con JS", la decisión sale mal en las dos direcciones: se desactiva
 * un medio que funciona, o se deja uno que gasta tiempo de cada corrida diaria
 * para nada.
 *
 * Todo se prueba con un fetch inyectado, sin salir a internet.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  urlEfectiva,
  clasificarError,
  contarEnlaces,
  detectarIndicioPaywall,
  verificarMedio,
  tablaMarkdown,
  resumen,
  type Resultado,
} from '../../scripts/pipeline/verificar-medios'
import { MEDIOS } from '../../scripts/pipeline/medios-config'

const RAIZ = process.cwd()

/** Un fetch falso que devuelve el HTML dado. */
function fetchFalso(html: string, init: { status?: number; url?: string } = {}) {
  return (async (url: string | URL) => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? String(url),
    text: async () => html,
  })) as unknown as typeof fetch
}

function fetchQueFalla(error: unknown) {
  return (async () => { throw error }) as unknown as typeof fetch
}

const HTML_CON_ENLACES = '<html><body>' + '<a href="/nota">x</a>'.repeat(30) + '</body></html>'

describe('urlEfectiva refleja lo que el pipeline visita', () => {
  test('urlPoliciales gana sobre url', () => {
    // Es el mismo orden que scrapear-medios.ts: `medio.urlPoliciales || medio.url`.
    // Si se invirtiera, el health-check verificaría una URL distinta de la que se
    // scrapea, y el reporte sería sobre otra cosa.
    assert.equal(
      urlEfectiva({ id: 'x', nombre: 'X', url: 'https://viejo', urlPoliciales: 'https://nuevo' }),
      'https://nuevo'
    )
  })

  test('cae a url cuando no hay urlPoliciales', () => {
    assert.equal(urlEfectiva({ id: 'x', nombre: 'X', url: 'https://legado' }), 'https://legado')
  })

  test('devuelve vacío si no hay ninguna', () => {
    assert.equal(urlEfectiva({ id: 'x', nombre: 'X' }), '')
  })

  test('los 74 medios configurados tienen una URL efectiva', () => {
    const sinUrl = MEDIOS.filter(m => urlEfectiva(m) === '')
    assert.deepEqual(sinUrl.map(m => m.id), [])
  })
})

describe('clasificarError distingue los fallos que se vieron en producción', () => {
  test('dominio muerto (jornada, lamanana)', () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    assert.equal(clasificarError(e).estado, 'DNS_MUERTO')
  })

  test('certificado inválido (cadenaargentina)', () => {
    const e = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    })
    assert.equal(clasificarError(e).estado, 'TLS_INVALIDO')
  })

  test('timeout (tiemposanjuan, ellitoralcorrientes)', () => {
    const e = Object.assign(new Error('abortado'), { name: 'AbortError' })
    assert.equal(clasificarError(e).estado, 'TIMEOUT')
  })

  test('conexión rechazada y cortada quedan como ERROR con detalle', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET']) {
      const r = clasificarError(Object.assign(new Error('x'), { cause: { code } }))
      assert.equal(r.estado, 'ERROR')
      assert.ok(r.detalle.length > 0, 'el detalle no debería quedar vacío')
    }
  })

  test('un error desconocido no explota y trae algo legible', () => {
    const r = clasificarError(new Error('algo raro pasó'))
    assert.equal(r.estado, 'ERROR')
    assert.match(r.detalle, /algo raro/)
  })
})

describe('contarEnlaces y el indicio de paywall', () => {
  test('cuenta los <a href>', () => {
    assert.equal(contarEnlaces('<a href="/a">1</a><A HREF="/b">2</A>'), 2)
  })

  test('no cuenta los <a> sin href', () => {
    assert.equal(contarEnlaces('<a name="x"></a>'), 0)
  })

  test('detecta señales de muro de pago, sin importar mayúsculas', () => {
    assert.equal(detectarIndicioPaywall('<p>SUSCRIBITE para seguir</p>'), true)
    assert.equal(detectarIndicioPaywall('<p>contenido exclusivo para suscriptores</p>'), true)
    assert.equal(detectarIndicioPaywall('<p>noticias policiales</p>'), false)
  })
})

describe('verificarMedio', () => {
  const medio = { id: 'x', nombre: 'Medio X', provincia: 'Buenos Aires', urlPoliciales: 'https://medio.com.ar/policiales' }

  test('OK cuando carga y trae enlaces', async () => {
    const r = await verificarMedio(medio, fetchFalso(HTML_CON_ENLACES))
    assert.equal(r.estado, 'OK')
    assert.equal(r.enlaces, 30)
  })

  test('SIN_ENLACES y no error cuando la página probablemente renderiza con JS', async () => {
    // Distinción deliberada: el pipeline usa Chrome y ejecuta JS, así que un
    // sitio así puede funcionar perfectamente. Marcarlo como roto llevaría a
    // desactivar medios que sirven.
    const r = await verificarMedio(medio, fetchFalso('<html><body><div id="app"></div></body></html>'))
    assert.equal(r.estado, 'SIN_ENLACES')
    assert.match(r.detalle, /JS/)
  })

  test('un 403 se marca BLOQUEADO, no como fallo del medio', async () => {
    // Lección de la primera corrida real: dio 403/404 en ~30 medios, y varios de
    // esos —rosario3, infocielo, lavoz, eltribuno, norte— aparecen scrapeando
    // bien en los logs del pipeline, que usa Chrome real. Era el WAF rechazando
    // un fetch sin browser. Reportarlos como fallo llevaba a desactivar medios
    // que funcionan: peor que no tener el reporte.
    for (const status of [401, 403, 404, 429, 503]) {
      const r = await verificarMedio(medio, fetchFalso('', { status }))
      assert.equal(r.estado, 'BLOQUEADO', `HTTP ${status} debería ser inconcluyente`)
      assert.match(r.detalle, /NO concluyente/)
    }
  })

  test('un 500 sí es HTTP_ERROR', async () => {
    // Un error del servidor no es un WAF filtrando: es el sitio fallando.
    const r = await verificarMedio(medio, fetchFalso('', { status: 500 }))
    assert.equal(r.estado, 'HTTP_ERROR')
    assert.match(r.detalle, /500/)
  })

  test('REDIRECT_EXTERNO cuando termina en otro dominio', async () => {
    const r = await verificarMedio(medio, fetchFalso(HTML_CON_ENLACES, { url: 'https://otrositio.com/' }))
    assert.equal(r.estado, 'REDIRECT_EXTERNO')
    assert.match(r.detalle, /otrositio\.com/)
  })

  test('un redirect de www al dominio pelado NO es externo', async () => {
    // Es lo normal y no debería reportarse como problema.
    const conWww = { ...medio, urlPoliciales: 'https://www.medio.com.ar/policiales' }
    const r = await verificarMedio(conWww, fetchFalso(HTML_CON_ENLACES, { url: 'https://medio.com.ar/policiales' }))
    assert.equal(r.estado, 'OK')
  })

  test('SIN_URL si el medio no tiene ninguna', async () => {
    const r = await verificarMedio({ id: 'y', nombre: 'Y' }, fetchFalso(''))
    assert.equal(r.estado, 'SIN_URL')
  })

  test('propaga el error de red clasificado', async () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const r = await verificarMedio(medio, fetchQueFalla(e))
    assert.equal(r.estado, 'DNS_MUERTO')
  })

  test('registra si el medio está activo, que es lo que decide la urgencia', async () => {
    const inactivo = await verificarMedio({ ...medio, activo: false }, fetchFalso(HTML_CON_ENLACES))
    assert.equal(inactivo.activo, false)
    const activoPorDefecto = await verificarMedio(medio, fetchFalso(HTML_CON_ENLACES))
    assert.equal(activoPorDefecto.activo, true, 'sin el campo, el pipeline lo trata como activo')
  })
})

describe('el reporte prioriza lo accionable', () => {
  const base = { provincia: 'X', url: 'u', enlaces: 0, indicioPaywall: false, detalle: 'd' }
  const resultados: Resultado[] = [
    { ...base, id: 'ok1', nombre: 'OK', activo: true, estado: 'OK' },
    { ...base, id: 'muerto', nombre: 'Muerto', activo: true, estado: 'DNS_MUERTO' },
    { ...base, id: 'nuevo', nombre: 'Nuevo', activo: false, estado: 'OK' },
  ]

  test('la tabla pone los fallos arriba', () => {
    const filas = tablaMarkdown(resultados).split('\n').slice(2)
    assert.match(filas[0], /muerto/, 'lo roto tiene que estar primero')
  })

  test('un BLOQUEADO activo NO aparece como candidato a desactivar', () => {
    // La razón de existir del estado BLOQUEADO.
    const conBloqueado: Resultado[] = [
      { ...base, id: 'wafeado', nombre: 'Wafeado', activo: true, estado: 'BLOQUEADO' },
    ]
    const r = resumen(conBloqueado)
    assert.ok(!/ACTIVO\(S\) con problemas/.test(r), 'un 403 no es motivo para desactivar')
    assert.match(r, /sin veredicto/)
    assert.match(r, /NO desactivar/)
  })

  test('el resumen separa "activo y roto" de "inactivo y sirve"', () => {
    // Son las dos decisiones que el reporte tiene que habilitar: qué desactivar
    // y qué activar.
    const r = resumen(resultados)
    assert.match(r, /1 medio\(s\) ACTIVO\(S\) con problemas/)
    assert.match(r, /`muerto`/)
    assert.match(r, /1 medio\(s\) inactivo\(s\) que responden bien/)
    assert.match(r, /`nuevo`/)
  })

  test('un medio inactivo y roto no aparece como urgente', () => {
    const soloInactivoRoto: Resultado[] = [
      { ...base, id: 'z', nombre: 'Z', activo: false, estado: 'DNS_MUERTO' },
    ]
    assert.ok(!/ACTIVO\(S\) con problemas/.test(resumen(soloInactivoRoto)))
  })
})

describe('el workflow existe y no modifica nada', () => {
  const yml = readFileSync(path.join(RAIZ, '.github/workflows/verificar-medios.yml'), 'utf-8')

  test('se dispara solo a mano', () => {
    assert.match(yml, /workflow_dispatch/)
    assert.ok(!/\bschedule:/.test(yml), 'no debería correr en un timer contra sitios de terceros')
  })

  test('tiene permisos de solo lectura', () => {
    assert.match(yml, /permissions:\s*\n\s*contents: read/)
  })
})
