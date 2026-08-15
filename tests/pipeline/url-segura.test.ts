/**
 * Destinos prohibidos para el pipeline (SSRF).
 *
 * EL VECTOR
 * El pipeline abre la portada de cada medio (URL fija, de la config) y de ahí
 * avanza haciendo CLICK en links de la página. El browser sigue adonde apunte
 * ese link. Cualquiera que consiga poner un `<a href>` en esa portada elige a
 * qué se conecta nuestro servidor, y el contenido de la respuesta se extrae y
 * se le manda al modelo.
 *
 * DÓNDE SUELEN FALLAR ESTOS FILTROS
 * No en `http://127.0.0.1`, que todo el mundo bloquea, sino en las formas
 * equivalentes: `http://2130706433`, `http://0177.0.0.1`, `http://127.1`,
 * `http://[::ffff:127.0.0.1]`. El resolver del sistema las trata a todas como
 * 127.0.0.1; un filtro que compare strings no. Por eso la mayor parte de estos
 * tests son de ofuscación.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  validarDestino,
  esDestinoPermitido,
  octetosIPv4,
  esIPv4Reservada,
  esIPv6Reservada,
  DestinoProhibidoError,
} from '../../src/lib/pipeline/url-segura'

describe('destinos legítimos siguen pasando', () => {
  // Si esto falla, el pipeline deja de scrapear: es la mitad que importa tanto
  // como bloquear lo malo.
  const MEDIOS_REALES = [
    'https://www.infobae.com/sociedad/policiales/',
    'https://www.rosario3.com/policiales/',
    'https://www.lavoz.com.ar/sucesos/',
    'https://www.eldia.com/seccion/policiales/',
    'https://www.lmneuquen.com/policiales/',
    'https://www.eltribuno.com/salta/policiales',
    'http://nuevarioja.com.ar/nota',
    'https://apis.datos.gob.ar/georef/api/provincias?nombre=Santa%20Fe',
  ]

  for (const url of MEDIOS_REALES) {
    test(`permite ${url.slice(0, 48)}`, () => {
      assert.equal(esDestinoPermitido(url), true)
    })
  }

  test('una IP pública cualquiera pasa', () => {
    assert.equal(esDestinoPermitido('https://8.8.8.8/'), true)
    assert.equal(esDestinoPermitido('https://190.210.1.1/nota'), true)
  })
})

describe('metadatos de nube — el destino que más importa', () => {
  test('bloquea 169.254.169.254', () => {
    // AWS, GCP y Azure sirven credenciales de la instancia en texto plano acá.
    assert.equal(esDestinoPermitido('http://169.254.169.254/latest/meta-data/'), false)
  })

  test('bloquea todo 169.254/16, no solo esa IP', () => {
    assert.equal(esDestinoPermitido('http://169.254.1.1/'), false)
  })

  test('bloquea los nombres de metadatos de GCP', () => {
    for (const h of ['http://metadata/', 'http://metadata.google.internal/', 'http://instance-data/']) {
      assert.equal(esDestinoPermitido(h), false, `debería bloquear ${h}`)
    }
  })
})

describe('loopback y redes privadas', () => {
  const PROHIBIDOS = [
    'http://127.0.0.1:5432/',
    'http://localhost:3000/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'http://100.64.0.1/',       // CGNAT
    'http://198.18.0.1/',       // benchmarking
    'http://224.0.0.1/',        // multicast
  ]

  for (const url of PROHIBIDOS) {
    test(`bloquea ${url}`, () => {
      assert.equal(esDestinoPermitido(url), false)
    })
  }

  test('172.32 NO es privada y debe pasar', () => {
    // El rango privado es 172.16–172.31: un filtro que bloquee todo 172/8
    // rompería destinos legítimos.
    assert.equal(esDestinoPermitido('http://172.32.0.1/'), true)
    assert.equal(esDestinoPermitido('http://172.15.0.1/'), true)
  })
})

describe('IPv4 ofuscada — donde fallan los filtros ingenuos', () => {
  test('decimal entero: 2130706433 es 127.0.0.1', () => {
    assert.deepEqual(octetosIPv4('2130706433'), [127, 0, 0, 1])
    assert.equal(esDestinoPermitido('http://2130706433/'), false)
  })

  test('octal: 0177.0.0.1 es 127.0.0.1', () => {
    assert.deepEqual(octetosIPv4('0177.0.0.1'), [127, 0, 0, 1])
    assert.equal(esDestinoPermitido('http://0177.0.0.1/'), false)
  })

  test('hexadecimal: 0x7f.0.0.1 es 127.0.0.1', () => {
    assert.deepEqual(octetosIPv4('0x7f.0.0.1'), [127, 0, 0, 1])
  })

  test('forma corta: 127.1 es 127.0.0.1', () => {
    assert.deepEqual(octetosIPv4('127.1'), [127, 0, 0, 1])
    assert.equal(esDestinoPermitido('http://127.1/'), false)
  })

  test('forma corta de tres partes: 10.0.1 es 10.0.0.1', () => {
    assert.deepEqual(octetosIPv4('10.0.1'), [10, 0, 0, 1])
  })

  test('el decimal de metadatos también se bloquea', () => {
    // 169.254.169.254 = 2852039166
    assert.deepEqual(octetosIPv4('2852039166'), [169, 254, 169, 254])
    assert.equal(esDestinoPermitido('http://2852039166/'), false)
  })

  test('un hostname normal no se confunde con una IP', () => {
    assert.equal(octetosIPv4('www.infobae.com'), null)
    assert.equal(octetosIPv4('example.org'), null)
  })

  test('octetos fuera de rango no son una IP válida', () => {
    assert.equal(octetosIPv4('999.1.1.1'), null)
    assert.equal(octetosIPv4('1.2.3.4.5'), null)
  })
})

describe('IPv6', () => {
  test('bloquea loopback ::1', () => {
    assert.equal(esIPv6Reservada('::1'), true)
    assert.equal(esDestinoPermitido('http://[::1]:8080/'), false)
  })

  test('bloquea únicas locales fc00::/7', () => {
    assert.equal(esIPv6Reservada('fd00::1'), true)
    assert.equal(esIPv6Reservada('fc00::1'), true)
  })

  test('bloquea enlace local fe80::/10', () => {
    assert.equal(esIPv6Reservada('fe80::1'), true)
  })

  test('bloquea IPv4 embebida en IPv6 — el bypass clásico', () => {
    assert.equal(esIPv6Reservada('::ffff:127.0.0.1'), true)
    assert.equal(esDestinoPermitido('http://[::ffff:169.254.169.254]/'), false)
  })

  test('una IPv6 pública pasa', () => {
    assert.equal(esIPv6Reservada('2001:4860:4860::8888'), false)
  })
})

describe('esquemas y formas de URL', () => {
  test('solo http y https', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:11211/',
      'ftp://interno/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      assert.equal(esDestinoPermitido(url), false, `debería bloquear ${url}`)
    }
  })

  test('rechaza credenciales embebidas en la URL', () => {
    // http://www.infobae.com@169.254.169.254/ apunta a la IP, no al medio:
    // se usa justamente para confundir a quien lee el log.
    assert.equal(esDestinoPermitido('http://usuario:clave@ejemplo.org/'), false)
    assert.equal(esDestinoPermitido('http://www.infobae.com@8.8.8.8/'), false)
  })

  test('el punto final del FQDN no evade el filtro', () => {
    // "localhost." resuelve igual que "localhost".
    assert.equal(esDestinoPermitido('http://localhost./'), false)
  })

  test('las mayúsculas no evaden el filtro', () => {
    assert.equal(esDestinoPermitido('http://LOCALHOST/'), false)
    assert.equal(esDestinoPermitido('http://LocalHost.LOCAL/'), false)
  })

  test('sufijos internos reservados', () => {
    for (const url of ['http://algo.internal/', 'http://impresora.local/', 'http://x.home.arpa/']) {
      assert.equal(esDestinoPermitido(url), false, `debería bloquear ${url}`)
    }
  })

  test('una URL no parseable se rechaza', () => {
    assert.equal(esDestinoPermitido('no es una url'), false)
    assert.equal(esDestinoPermitido(''), false)
  })
})

describe('validarDestino informa por qué rechaza', () => {
  test('lanza DestinoProhibidoError con el motivo', () => {
    assert.throws(
      () => validarDestino('http://169.254.169.254/'),
      (e: unknown) => {
        assert.ok(e instanceof DestinoProhibidoError)
        assert.match((e as Error).message, /IP reservada/)
        return true
      }
    )
  })

  test('devuelve la URL normalizada cuando es válida', () => {
    assert.equal(validarDestino('https://www.infobae.com/nota'), 'https://www.infobae.com/nota')
  })
})

describe('esIPv4Reservada, rangos exactos', () => {
  test('los límites de 172.16/12', () => {
    assert.equal(esIPv4Reservada([172, 15, 0, 0]), false)
    assert.equal(esIPv4Reservada([172, 16, 0, 0]), true)
    assert.equal(esIPv4Reservada([172, 31, 255, 255]), true)
    assert.equal(esIPv4Reservada([172, 32, 0, 0]), false)
  })

  test('los límites de 100.64/10 (CGNAT)', () => {
    assert.equal(esIPv4Reservada([100, 63, 0, 0]), false)
    assert.equal(esIPv4Reservada([100, 64, 0, 0]), true)
    assert.equal(esIPv4Reservada([100, 127, 255, 255]), true)
    assert.equal(esIPv4Reservada([100, 128, 0, 0]), false)
  })
})
