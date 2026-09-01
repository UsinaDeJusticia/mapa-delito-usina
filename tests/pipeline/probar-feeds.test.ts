/**
 * Probe de feeds — verifica que la cascada, el parseo y la clasificación de
 * fallos sean confiables antes de usarlos para decidir la Etapa 4 del plan.
 *
 * POR QUÉ IMPORTA
 * El script existe para producir UN número: qué porcentaje de medios tiene
 * feed usable. Si la cascada no respeta el orden, si un 403 se confunde con
 * "sin feed", o si un XML mal formado tumba la corrida, el número queda mal y
 * el plan se replantea (o no) con el dato equivocado.
 *
 * Todo se prueba con un fetch inyectado, sin salir a internet.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  origenDe,
  parsearFeedXML,
  extraerFeedsAutodiscovery,
  probarMedio,
  tablaMarkdown,
  resumen,
  UMBRAL_DIAS_FRESCURA,
  type ResultadoFeed,
} from '../../scripts/pipeline/probar-feeds'
import { MEDIOS } from '../../scripts/pipeline/medios-config'

const RAIZ = process.cwd()

const RSS_VALIDO = `<?xml version="1.0"?>
<rss><channel>
  <item><title>Mataron a un hombre en Rosario</title><link>https://x.com/a</link><pubDate>{{FECHA}}</pubDate></item>
</channel></rss>`

const ATOM_VALIDO = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Hallaron un cuerpo</title><link rel="alternate" href="https://x.com/b"/><updated>{{FECHA}}</updated></entry>
</feed>`

const SITEMAP_VALIDO = `<?xml version="1.0"?>
<urlset><url><loc>https://x.com/c</loc><lastmod>{{FECHA}}</lastmod></url></urlset>`

function conFecha(xml: string, fechaISO: string): string {
  return xml.replace('{{FECHA}}', fechaISO)
}

/** fetch falso que responde según una tabla de rutas -> {status, texto}. Todo lo no listado da 404. */
function fetchPorRuta(tabla: Record<string, { status?: number; texto?: string }>) {
  return (async (url: string | URL) => {
    const u = String(url)
    const entrada = tabla[u]
    const status = entrada?.status ?? 404
    return {
      ok: status < 400,
      status,
      url: u,
      text: async () => entrada?.texto ?? '',
    }
  }) as unknown as typeof fetch
}

function fetchQueFalla(error: unknown) {
  return (async () => {
    throw error
  }) as unknown as typeof fetch
}

const MEDIO_BASE = { id: 'x', nombre: 'Medio X', provincia: 'Buenos Aires', urlPoliciales: 'https://medio.com.ar/policiales' }

describe('origenDe deriva el dominio raíz, no la sección de policiales', () => {
  test('toma el origin de urlPoliciales', () => {
    assert.equal(origenDe(MEDIO_BASE), 'https://medio.com.ar')
  })

  test('cae a url cuando no hay urlPoliciales', () => {
    assert.equal(origenDe({ id: 'x', nombre: 'X', url: 'https://legado.com.ar/seccion' }), 'https://legado.com.ar')
  })

  test('null si no hay ninguna URL', () => {
    assert.equal(origenDe({ id: 'x', nombre: 'X' }), null)
  })

  test('los 120 medios configurados tienen un origen derivable', () => {
    const sinOrigen = MEDIOS.filter(m => origenDe(m) === null)
    assert.deepEqual(sinOrigen.map(m => m.id), [])
  })
})

describe('parsearFeedXML distingue RSS, Atom y sitemap', () => {
  test('RSS: <item> con pubDate', () => {
    const r = parsearFeedXML(conFecha(RSS_VALIDO, 'Wed, 01 Jan 2025 10:00:00 GMT'))
    assert.equal(r.tipo, 'rss')
    assert.equal(r.items.length, 1)
    assert.equal(r.items[0].url, 'https://x.com/a')
    assert.ok(r.items[0].fecha instanceof Date)
  })

  test('Atom: <entry> con link como atributo href, no como texto', () => {
    const r = parsearFeedXML(conFecha(ATOM_VALIDO, '2025-01-01T10:00:00Z'))
    assert.equal(r.tipo, 'atom')
    assert.equal(r.items[0].url, 'https://x.com/b')
    assert.ok(r.items[0].fecha instanceof Date)
  })

  test('sitemap: <url><loc>', () => {
    const r = parsearFeedXML(conFecha(SITEMAP_VALIDO, '2025-01-01'))
    assert.equal(r.tipo, 'sitemap')
    assert.equal(r.items[0].url, 'https://x.com/c')
  })

  test('sitemapindex: entradas <sitemap>, sin fechas', () => {
    const r = parsearFeedXML('<sitemapindex><sitemap><loc>https://x.com/sitemap1.xml</loc></sitemap></sitemapindex>')
    assert.equal(r.tipo, 'sitemap-index')
    assert.equal(r.items[0].fecha, null)
  })

  test('XML sin item/entry/url reconocibles da items vacío, no explota', () => {
    const r = parsearFeedXML('<algo><otracosa/></algo>')
    assert.equal(r.items.length, 0)
  })

  test('XML mal formado lanza — quien llama lo captura', () => {
    assert.throws(() => parsearFeedXML('<rss><channel><item><title>sin cerrar'))
  })
})

describe('extraerFeedsAutodiscovery', () => {
  test('extrae href de <link rel=alternate>, resolviendo relativo contra el origen', () => {
    const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
    const r = extraerFeedsAutodiscovery(html, 'https://medio.com.ar')
    assert.deepEqual(r, ['https://medio.com.ar/feed.xml'])
  })

  test('funciona con mayúsculas en los atributos (rel, type, href)', () => {
    const html = '<html><head><LINK REL="ALTERNATE" TYPE="APPLICATION/RSS+XML" HREF="https://medio.com.ar/otro.xml"></head></html>'
    const r = extraerFeedsAutodiscovery(html, 'https://medio.com.ar')
    assert.deepEqual(r, ['https://medio.com.ar/otro.xml'])
  })

  test('también reconoce atom+xml', () => {
    const html = '<link rel="alternate" type="application/atom+xml" href="/atom.xml">'
    const r = extraerFeedsAutodiscovery(html, 'https://medio.com.ar')
    assert.deepEqual(r, ['https://medio.com.ar/atom.xml'])
  })

  test('ignora <link> que no son alternate o de otro tipo (ej. stylesheet)', () => {
    const html = '<link rel="stylesheet" href="/estilos.css"><link rel="alternate" type="application/rss+xml" href="/feed.xml">'
    const r = extraerFeedsAutodiscovery(html, 'https://medio.com.ar')
    assert.deepEqual(r, ['https://medio.com.ar/feed.xml'])
  })

  test('sin ningún <link> alternate devuelve vacío', () => {
    assert.deepEqual(extraerFeedsAutodiscovery('<html><head></head></html>', 'https://medio.com.ar'), [])
  })
})

describe('probarMedio respeta el orden de la cascada', () => {
  test('se queda con sitemap-news.xml si funciona, sin probar nada más', async () => {
    const fecha = new Date().toISOString()
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap-news.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, fecha) },
      'https://medio.com.ar/sitemap.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, fecha) }, // si esto se probara también daría OK
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'ENCONTRADO')
    assert.equal(r.estrategia, '/sitemap-news.xml')
    assert.equal(r.intentos.length, 1, 'no debería haber probado nada después de la primera que sirvió')
  })

  test('si sitemap-news.xml falla (404), sigue con sitemap.xml', async () => {
    const fecha = new Date().toISOString()
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, fecha) },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'ENCONTRADO')
    assert.equal(r.estrategia, '/sitemap.xml')
    assert.equal(r.intentos[0].resultado, 'HTTP_ERROR') // el 404 de sitemap-news.xml
  })

  test('si ningún sitemap/RSS funciona, cae a autodiscovery', async () => {
    const fecha = new Date().toISOString()
    const feedHtml = '<html><head><link rel="alternate" type="application/rss+xml" href="/oculto.xml"></head></html>'
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar': { status: 200, texto: feedHtml },
      'https://medio.com.ar/oculto.xml': { status: 200, texto: conFecha(RSS_VALIDO, fecha) },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'ENCONTRADO')
    assert.equal(r.estrategia, 'autodiscovery:https://medio.com.ar/oculto.xml')
    assert.equal(r.feedUrl, 'https://medio.com.ar/oculto.xml')
  })

  test('si nada funciona, SIN_FEED con motivo', async () => {
    const fetchImpl = fetchPorRuta({}) // todo 404, incluida la portada
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'SIN_FEED')
    assert.ok(r.motivo.length > 0)
  })
})

describe('un 403 es inconcluyente, no "sin feed" — la lección que ya se pagó una vez', () => {
  for (const status of [401, 403, 429, 503]) {
    test(`HTTP ${status} en toda la cascada da INCONCLUSO`, async () => {
      const fetchImpl = fetchPorRuta(
        Object.fromEntries(
          [
            'https://medio.com.ar/sitemap-news.xml',
            'https://medio.com.ar/sitemap.xml',
            'https://medio.com.ar/news-sitemap.xml',
            'https://medio.com.ar/sitemap_index.xml',
            'https://medio.com.ar/rss',
            'https://medio.com.ar/feed',
            'https://medio.com.ar/rss.xml',
            'https://medio.com.ar/feed.xml',
            'https://medio.com.ar/rss/',
            'https://medio.com.ar/arc/outboundfeeds/rss/',
            'https://medio.com.ar/',
          ].map(u => [u, { status }])
        )
      )
      const r = await probarMedio(MEDIO_BASE, fetchImpl)
      assert.equal(r.estado, 'INCONCLUSO', `HTTP ${status} debería ser inconcluyente, no SIN_FEED`)
      assert.match(r.motivo, /WAF|no concluyente/i)
    })
  }

  test('un 404 puntual en una ruta NO hace inconcluyente todo el medio', async () => {
    // 404 es una respuesta determinante para ESA ruta (no existe), muy
    // distinto de un WAF bloqueando. Si todas las rutas dan 404 limpio, el
    // veredicto es SIN_FEED, no INCONCLUSO.
    const fetchImpl = fetchPorRuta({}) // todo 404
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'SIN_FEED')
  })
})

describe('un XML mal formado no tumba la corrida', () => {
  test('la ruta con XML roto se descarta y la cascada sigue', async () => {
    const fecha = new Date().toISOString()
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap-news.xml': { status: 200, texto: '<urlset><url><loc>sin cerrar' },
      'https://medio.com.ar/sitemap.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, fecha) },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'ENCONTRADO')
    assert.equal(r.estrategia, '/sitemap.xml')
    assert.equal(r.intentos[0].resultado, 'NO_XML')
  })

  test('si TODO es XML roto, da SIN_FEED en vez de lanzar', async () => {
    const fetchImpl = fetchPorRuta(
      Object.fromEntries(
        [
          '/sitemap-news.xml', '/sitemap.xml', '/news-sitemap.xml', '/sitemap_index.xml',
          '/rss', '/feed', '/rss.xml', '/feed.xml', '/rss/', '/arc/outboundfeeds/rss/',
        ].map(p => [`https://medio.com.ar${p}`, { status: 200, texto: '<rss><item><title>roto' }])
      )
    )
    await assert.doesNotReject(async () => {
      const r = await probarMedio(MEDIO_BASE, fetchImpl)
      assert.equal(r.estado, 'SIN_FEED')
    })
  })
})

describe('frescura', () => {
  test('un feed con ítems viejos se marca no fresco', async () => {
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap-news.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, '2019-01-01') },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.estado, 'ENCONTRADO')
    assert.equal(r.tieneFechas, true)
    assert.equal(r.fresco, false)
  })

  test('un feed con ítems de hoy se marca fresco', async () => {
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap-news.xml': { status: 200, texto: conFecha(SITEMAP_VALIDO, new Date().toISOString()) },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.fresco, true)
  })

  test(`el umbral de frescura es ${UMBRAL_DIAS_FRESCURA} días`, () => {
    assert.equal(typeof UMBRAL_DIAS_FRESCURA, 'number')
    assert.ok(UMBRAL_DIAS_FRESCURA > 0)
  })

  test('un feed sin fechas parseables no se marca ni fresco ni viejo', async () => {
    const fetchImpl = fetchPorRuta({
      'https://medio.com.ar/sitemap-news.xml': { status: 200, texto: '<urlset><url><loc>https://x.com/a</loc></url></urlset>' },
    })
    const r = await probarMedio(MEDIO_BASE, fetchImpl)
    assert.equal(r.tieneFechas, false)
    assert.equal(r.fresco, null)
  })
})

describe('errores de red se clasifican, no se pierden', () => {
  test('DNS muerto corta la cascada temprano (no tiene sentido seguir probando rutas)', async () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    const r = await probarMedio(MEDIO_BASE, fetchQueFalla(e))
    assert.equal(r.estado, 'SIN_FEED')
    assert.equal(r.intentos.length, 1, 'DNS muerto es del dominio entero, no vale seguir probando rutas')
    assert.match(r.motivo, /DNS_MUERTO/)
  })
})

describe('el reporte', () => {
  const activo1: ResultadoFeed = {
    id: 'a', nombre: 'A', provincia: 'X', activo: true, origen: 'https://a.com',
    estrategia: '/sitemap-news.xml', feedUrl: 'https://a.com/sitemap-news.xml', items: 5,
    tieneFechas: true, fresco: true, fechaMasReciente: new Date().toISOString(),
    estado: 'ENCONTRADO', motivo: 'ok', intentos: [],
  }
  const inconcluso: ResultadoFeed = {
    id: 'b', nombre: 'B', provincia: 'X', activo: true, origen: 'https://b.com',
    estrategia: null, feedUrl: null, items: 0, tieneFechas: false, fresco: null, fechaMasReciente: null,
    estado: 'INCONCLUSO', motivo: 'WAF, no concluyente', intentos: [],
  }
  const sinFeed: ResultadoFeed = {
    id: 'c', nombre: 'C', provincia: 'X', activo: false, origen: 'https://c.com',
    estrategia: null, feedUrl: null, items: 0, tieneFechas: false, fresco: null, fechaMasReciente: null,
    estado: 'SIN_FEED', motivo: 'nada funcionó', intentos: [],
  }

  test('tablaMarkdown separa las tres secciones', () => {
    const t = tablaMarkdown([activo1, inconcluso, sinFeed])
    assert.match(t, /medio\(s\) con feed usable/)
    assert.match(t, /INCONCLUYENTE/)
    assert.match(t, /sin feed encontrado/)
    assert.match(t, /`a`/)
    assert.match(t, /`b`/)
    assert.match(t, /`c`/)
  })

  test('resumen calcula el porcentaje sobre activos y sobre el total', () => {
    const r = resumen([activo1, inconcluso, sinFeed])
    assert.match(r, /1\/2/) // 1 de 2 activos (a y b son activos, c no)
    assert.match(r, /1\/3/) // 1 de 3 totales
  })
})

describe('el workflow existe, es manual y no escribe nada', () => {
  const yml = readFileSync(path.join(RAIZ, '.github/workflows/probar-feeds.yml'), 'utf-8')

  test('se dispara solo a mano', () => {
    assert.match(yml, /workflow_dispatch/)
    assert.ok(!/\bschedule:/.test(yml), 'no debería correr en un timer contra sitios de terceros')
  })

  test('tiene permisos de solo lectura', () => {
    assert.match(yml, /permissions:\s*\n\s*contents: read/)
  })

  test('usa tee para que el reporte quede también en los logs, no solo en el summary', () => {
    assert.match(yml, /\|\s*tee\s+-a\s+"\$GITHUB_STEP_SUMMARY"/)
    assert.ok(!/>>\s*"\$GITHUB_STEP_SUMMARY"/.test(yml), 'no debería usar >> — se pierde el log')
  })
})
