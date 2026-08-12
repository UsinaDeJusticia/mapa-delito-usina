import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  urlSegura,
  contenidoHechoMedio,
  contenidoProvincia,
  contenidoCeldaH3,
} from '../../src/lib/mapa/infowindow-dom'
import { SIN_DATO, PARCIAL } from '../../src/lib/mapa/metricas'

let doc: Document

before(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document
})

/**
 * Payloads que un medio scrapeado podría dejar en el título, el medio o la
 * ubicación. Antes del arreglo llegaban a InfoWindow.setContent(string), que los
 * interpretaba como HTML.
 */
const PAYLOADS_XSS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(document.cookie)</script>',
  '<svg/onload=alert(1)>',
  '"><script>alert(1)</script>',
  "'><img src=x onerror=alert(1)>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<body onload=alert(1)>',
  '<div onmouseover="alert(1)">hover</div>',
  '<style>*{background:url(javascript:alert(1))}</style>',
  '<object data="data:text/html,<script>alert(1)</script>">',
  '</div><script>fetch("/api/admin/revisiones")</script><div>',
  '<img src=1 href=1 onerror="javascript:alert(1)">',
  '<link rel=import href="data:text/html,<script>alert(1)</script>">',
  '<math><mtext></mtext><script>alert(1)</script></math>',
  '<!--<img src="--><img src=x onerror=alert(1)//">',
]

/** Verifica que ningún payload se materialice como nodo ejecutable. */
function assertSinHtmlEjecutable(el: HTMLElement, payload: string) {
  for (const tag of ['script', 'img', 'svg', 'iframe', 'object', 'style', 'link', 'math']) {
    assert.equal(
      el.querySelector(tag),
      null,
      `no debería existir un <${tag}> a partir de ${JSON.stringify(payload)}`
    )
  }
  // Ningún elemento con handler inline
  for (const nodo of Array.from(el.querySelectorAll('*'))) {
    for (const attr of Array.from(nodo.attributes)) {
      assert.ok(
        !attr.name.toLowerCase().startsWith('on'),
        `atributo de evento inline inesperado: ${attr.name}`
      )
    }
  }
}

describe('urlSegura', () => {
  test('acepta https y http', () => {
    assert.equal(
      urlSegura('https://www.rosario3.com/nota'),
      'https://www.rosario3.com/nota'
    )
    assert.ok(urlSegura('http://nuevarioja.com.ar/nota')?.startsWith('http://'))
  })

  test('rechaza javascript:, data: y vbscript:', () => {
    for (const u of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)  ',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
    ]) {
      assert.equal(urlSegura(u), null, `debería rechazar ${u}`)
    }
  })

  test('rechaza relativas, vacías y no strings', () => {
    for (const u of ['', '   ', '/nota/1', 'nota.html', null, undefined, 42, {}]) {
      assert.equal(urlSegura(u), null, `debería rechazar ${JSON.stringify(u)}`)
    }
  })
})

describe('contenidoHechoMedio — títulos y medios hostiles', () => {
  for (const payload of PAYLOADS_XSS) {
    test(`neutraliza el payload en el título: ${payload.slice(0, 32)}`, () => {
      const el = contenidoHechoMedio(
        { titulo: payload, esVerificado: true },
        doc
      )
      assertSinHtmlEjecutable(el, payload)
      // El payload sigue visible como texto, no se pierde información
      assert.ok(
        el.textContent?.includes(payload),
        'el payload debe quedar como texto literal'
      )
    })
  }

  test('neutraliza payloads en medio, ciudad, provincia y tipo de delito', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const el = contenidoHechoMedio(
      {
        titulo: 'Título normal',
        medio: payload,
        ciudad: payload,
        provincia: payload,
        tipo_delito: payload,
        esVerificado: false,
      },
      doc
    )
    assertSinHtmlEjecutable(el, payload)
  })

  test('no crea el link cuando la URL es javascript:', () => {
    const el = contenidoHechoMedio(
      { titulo: 'x', url_cobertura: 'javascript:alert(1)', esVerificado: true },
      doc
    )
    assert.equal(el.querySelector('a'), null, 'no debe haber link con URL insegura')
  })

  test('no crea el link cuando la URL es data:', () => {
    const el = contenidoHechoMedio(
      {
        titulo: 'x',
        url_cobertura: 'data:text/html,<script>alert(1)</script>',
        esVerificado: true,
      },
      doc
    )
    assert.equal(el.querySelector('a'), null)
  })

  test('crea el link con https y mantiene noopener noreferrer', () => {
    const el = contenidoHechoMedio(
      { titulo: 'x', url_cobertura: 'https://www.infobae.com/nota', esVerificado: true },
      doc
    )
    const a = el.querySelector('a')
    assert.ok(a, 'debe haber link')
    assert.equal(a!.getAttribute('href'), 'https://www.infobae.com/nota')
    assert.equal(a!.getAttribute('target'), '_blank')
    const rel = a!.getAttribute('rel') ?? ''
    assert.ok(rel.includes('noopener'), 'rel debe incluir noopener')
    assert.ok(rel.includes('noreferrer'), 'rel debe incluir noreferrer')
  })

  test('un href con comillas y markup no rompe el atributo', () => {
    const el = contenidoHechoMedio(
      {
        titulo: 'x',
        url_cobertura: 'https://ok.test/a"><script>alert(1)</script>',
        esVerificado: true,
      },
      doc
    )
    assertSinHtmlEjecutable(el, 'href hostil')
    const a = el.querySelector('a')
    if (a) {
      // Si se creó, el href debe estar percent-encoded por new URL(), no romper el markup
      assert.ok(!a.getAttribute('href')!.includes('<script>'))
    }
  })

  test('muestra el badge correcto según verificación', () => {
    const v = contenidoHechoMedio({ titulo: 'x', esVerificado: true }, doc)
    assert.match(v.textContent!, /Verificado/)
    const p = contenidoHechoMedio({ titulo: 'x', esVerificado: false }, doc)
    assert.match(p.textContent!, /Preliminar/)
  })

  test('tolera todos los campos ausentes', () => {
    const el = contenidoHechoMedio({ esVerificado: false }, doc)
    assert.match(el.textContent!, /Sin título/)
    assert.equal(el.querySelector('a'), null)
  })
})

describe('contenidoProvincia — nombres de provincia y delito hostiles', () => {
  for (const payload of PAYLOADS_XSS.slice(0, 6)) {
    test(`neutraliza el payload en el nombre de provincia: ${payload.slice(0, 28)}`, () => {
      const el = contenidoProvincia(
        { provincia: payload, totalHechos: 10, totalVictimas: 12 },
        doc
      )
      assertSinHtmlEjecutable(el, payload)
      assert.ok(el.textContent?.includes(payload))
    })
  }

  test('neutraliza el payload en el nombre de un delito', () => {
    const payload = '<svg/onload=alert(1)>'
    const el = contenidoProvincia(
      {
        provincia: 'Santa Fe',
        totalHechos: 5,
        totalVictimas: 6,
        delitos: [{ nombre: payload, hechos: 3 }],
      },
      doc
    )
    assertSinHtmlEjecutable(el, payload)
  })

  test('ordena los delitos por cantidad y muestra hasta tres', () => {
    const el = contenidoProvincia(
      {
        provincia: 'Buenos Aires',
        totalHechos: 100,
        totalVictimas: 110,
        delitos: [
          { nombre: 'Tercero', hechos: 3 },
          { nombre: 'Primero', hechos: 30 },
          { nombre: 'Cuarto', hechos: 1 },
          { nombre: 'Segundo', hechos: 10 },
        ],
      },
      doc
    )
    const texto = el.textContent!
    assert.ok(texto.includes('Primero') && texto.includes('Segundo') && texto.includes('Tercero'))
    assert.ok(!texto.includes('Cuarto'), 'solo debe mostrar los tres primeros')
    assert.ok(texto.indexOf('Primero') < texto.indexOf('Segundo'), 'debe ir ordenado')
  })

  test('no muta el array de delitos que recibe', () => {
    const delitos = [
      { nombre: 'A', hechos: 1 },
      { nombre: 'B', hechos: 5 },
    ]
    contenidoProvincia({ provincia: 'X', delitos }, doc)
    assert.equal(delitos[0].nombre, 'A', 'el orden original debe preservarse')
  })

  test('tolera nulls y valores no numéricos', () => {
    const el = contenidoProvincia(
      {
        provincia: null,
        totalHechos: null,
        totalVictimas: undefined as unknown as number,
        delitos: [{ nombre: null, hechos: null }],
      },
      doc
    )
    assert.match(el.textContent!, /Sin nombre/)
    assert.match(el.textContent!, /Sin clasificar/)
  })
})

describe('contenidoCeldaH3', () => {
  test('muestra los conteos con singular y plural correctos', () => {
    const uno = contenidoCeldaH3({ count: 1, victimas: 1 }, doc)
    assert.match(uno.textContent!, /1 hecho(?!s)/)
    assert.match(uno.textContent!, /1 víctima(?!s)/)

    const varios = contenidoCeldaH3({ count: 4, victimas: 7 }, doc)
    assert.match(varios.textContent!, /4 hechos/)
    assert.match(varios.textContent!, /7 víctimas/)
  })

  test('no genera HTML ejecutable ni con valores manipulados', () => {
    // count y victimas son numéricos por tipo, pero se fuerza el caso límite
    const el = contenidoCeldaH3(
      { count: '<img src=x onerror=alert(1)>' as unknown as number, victimas: NaN },
      doc
    )
    assertSinHtmlEjecutable(el, 'count no numérico')
    assert.match(el.textContent!, /0 hechos/)
  })
})

/**
 * Sin dato vs cero, en la capa donde el usuario lo ve.
 *
 * El conteo de víctimas puede faltar en la fuente. Antes se renderizaba como
 * "0 víctimas", que se lee como "no hubo víctimas". Estos tests fijan que la
 * ausencia se diga con palabras y que un cero medido siga mostrándose como 0.
 */
describe('víctimas sin dato en los globos del mapa', () => {
  test('la burbuja provincial dice "sin dato", no 0', () => {
    const el = contenidoProvincia(
      { provincia: 'Chubut', totalHechos: 312, totalVictimas: null, delitos: [] },
      doc
    )
    const texto = el.textContent!
    assert.ok(texto.includes(SIN_DATO), `debería decir "${SIN_DATO}": ${texto}`)
    assert.ok(
      !/Víctimas\s*0(?!\d)/.test(texto),
      'no debe afirmar cero víctimas donde no se sabe cuántas hubo'
    )
    assert.ok(texto.includes('312'), 'los hechos, que sí se conocen, se siguen mostrando')
  })

  test('un cero medido sigue siendo 0', () => {
    // Distinguir ausencia de cero no debe borrar los ceros legítimos.
    const el = contenidoProvincia(
      { provincia: 'Tierra del Fuego', totalHechos: 0, totalVictimas: 0, delitos: [] },
      doc
    )
    const texto = el.textContent!
    assert.ok(!texto.includes(SIN_DATO), 'un cero medido no es una ausencia')
    assert.match(texto, /0/)
  })

  test('la celda H3 sin conteo de víctimas no inventa una por hecho', () => {
    // El bug: `Number(row.cantidad_victimas) || 1` hacía que cada hecho sin dato
    // contara como una víctima, así que la celda siempre mostraba una cifra.
    const el = contenidoCeldaH3({ count: 4, victimas: null }, doc)
    const texto = el.textContent!
    assert.match(texto, /4 hechos/)
    assert.ok(texto.includes(SIN_DATO), `debería decir "${SIN_DATO}": ${texto}`)
    assert.ok(!/\d+ víctimas/.test(texto), 'no debe afirmar una cantidad de víctimas')
  })

  test('la celda H3 avisa cuando el conteo es parcial', () => {
    const el = contenidoCeldaH3({ count: 5, victimas: 3, victimasParcial: true }, doc)
    const texto = el.textContent!
    assert.match(texto, /3 víctimas/)
    assert.ok(texto.includes(PARCIAL), 'un total incompleto tiene que declararse')
  })

  test('un conteo completo no se marca como parcial', () => {
    const el = contenidoCeldaH3({ count: 2, victimas: 2, victimasParcial: false }, doc)
    assert.ok(!el.textContent!.includes(PARCIAL))
  })
})
