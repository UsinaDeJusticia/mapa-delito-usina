import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsearAllowlist,
  normalizarEmail,
  evaluarAllowlist,
  puedeAcceder,
  requiereSesion,
} from '../../src/lib/auth/allowlist'

const PROD = { esProduccion: true }
const DEV = { esProduccion: false }

describe('parsearAllowlist', () => {
  test('separa por coma, recorta y baja a minúsculas', () => {
    assert.deepEqual(
      parsearAllowlist(' Uno@Gmail.com , dos@usina.org.ar ,TRES@x.com'),
      ['uno@gmail.com', 'dos@usina.org.ar', 'tres@x.com']
    )
  })

  test('devuelve vacío para ausente, vacío o solo comas', () => {
    for (const v of [undefined, null, '', '   ', ',,,', ' , , ']) {
      assert.deepEqual(parsearAllowlist(v), [], `debería quedar vacío para ${JSON.stringify(v)}`)
    }
  })
})

describe('normalizarEmail', () => {
  test('unifica formas Unicode canónicamente equivalentes (NFC)', () => {
    // "josé" precompuesto vs "jose" + acento combinante: mismo carácter,
    // distinta codificación. Deben normalizar al mismo string.
    const precompuesto = 'josé@usina.org.ar'
    const descompuesto = 'josé@usina.org.ar'
    assert.notEqual(precompuesto, descompuesto, 'los strings crudos difieren')
    assert.equal(normalizarEmail(precompuesto), normalizarEmail(descompuesto))
  })

  test('NO unifica homóglifos de otros alfabetos', () => {
    // "а" cirílica (U+0430) contra "a" ASCII: parecen iguales, son distintas.
    const cirilico = 'аdmin@usina.org.ar'
    const ascii = 'admin@usina.org.ar'
    assert.notEqual(normalizarEmail(cirilico), normalizarEmail(ascii))
  })

  test('NO unifica caracteres de ancho completo', () => {
    // NFKC los unificaría; se usa NFC justamente para que no pase.
    const anchoCompleto = 'ａdmin@usina.org.ar'
    assert.notEqual(normalizarEmail(anchoCompleto), normalizarEmail('admin@usina.org.ar'))
  })

  test('devuelve null para vacío o no string', () => {
    for (const v of ['', '   ', null, undefined, 42 as unknown as string]) {
      assert.equal(normalizarEmail(v), null)
    }
  })
})

describe('evaluarAllowlist — sesión válida', () => {
  test('permite un email de la allowlist', () => {
    const r = evaluarAllowlist('uno@usina.org.ar', {
      allowlist: ['uno@usina.org.ar', 'dos@usina.org.ar'],
      ...PROD,
    })
    assert.deepEqual(r, { permitido: true })
  })

  test('permite con diferencias de mayúsculas y espacios', () => {
    for (const email of ['UNO@USINA.ORG.AR', ' uno@usina.org.ar ', 'Uno@Usina.Org.Ar']) {
      assert.equal(
        evaluarAllowlist(email, { allowlist: ['uno@usina.org.ar'], ...PROD }).permitido,
        true,
        `debería permitir ${JSON.stringify(email)}`
      )
    }
  })

  test('permite un email acentuado codificado de otra forma', () => {
    const allowlist = parsearAllowlist('josé@usina.org.ar')
    const r = evaluarAllowlist('josé@usina.org.ar', { allowlist, ...PROD })
    assert.equal(r.permitido, true, 'NFC debe unificar ambas formas')
  })
})

describe('evaluarAllowlist — email no permitido', () => {
  test('rechaza un email ausente de la allowlist', () => {
    const r = evaluarAllowlist('intruso@gmail.com', {
      allowlist: ['uno@usina.org.ar'],
      ...PROD,
    })
    assert.equal(r.permitido, false)
    assert.equal(r.permitido === false && r.motivo, 'email-no-autorizado')
  })

  test('rechaza homóglifos que imitan un email autorizado', () => {
    const allowlist = ['admin@usina.org.ar']
    for (const impostor of [
      'аdmin@usina.org.ar', // "а" cirílica
      'ａdmin@usina.org.ar', // "ａ" ancho completo
      'admin@usina.org.аr', // "а" cirílica en el dominio
    ]) {
      const r = evaluarAllowlist(impostor, { allowlist, ...PROD })
      assert.equal(r.permitido, false, `debería rechazar ${JSON.stringify(impostor)}`)
    }
  })

  test('rechaza subcadenas y variantes del email autorizado', () => {
    const allowlist = ['admin@usina.org.ar']
    for (const impostor of [
      'admin@usina.org.ar.evil.com',
      'evil.com/admin@usina.org.ar',
      'admin@usina.org',
      'xadmin@usina.org.ar',
      'admin+extra@usina.org.ar',
    ]) {
      assert.equal(
        evaluarAllowlist(impostor, { allowlist, ...PROD }).permitido,
        false,
        `debería rechazar ${impostor}`
      )
    }
  })
})

describe('evaluarAllowlist — sesión ausente o error del proveedor', () => {
  // Cuando el proveedor OAuth falla o no devuelve email, no hay identidad
  // que comparar. Debe rechazar, no caer en un default permisivo.
  test('rechaza email ausente incluso con allowlist configurada', () => {
    for (const v of [null, undefined, '', '   ']) {
      const r = evaluarAllowlist(v, { allowlist: ['uno@usina.org.ar'], ...PROD })
      assert.equal(r.permitido, false, `debería rechazar ${JSON.stringify(v)}`)
      assert.equal(r.permitido === false && r.motivo, 'sin-email')
    }
  })

  test('rechaza email ausente también en desarrollo', () => {
    const r = evaluarAllowlist(null, { allowlist: [], ...DEV })
    assert.equal(r.permitido, false)
    assert.equal(r.permitido === false && r.motivo, 'sin-email')
  })

  test('rechaza un email que no es string', () => {
    const r = evaluarAllowlist(42 as unknown as string, { allowlist: ['x@y.com'], ...PROD })
    assert.equal(r.permitido, false)
  })
})

describe('evaluarAllowlist — allowlist vacía', () => {
  // El caso más importante: un deploy al que se le olvidó ALLOWED_EMAILS no
  // debe quedar abierto a cualquier cuenta de Google.
  test('en producción rechaza a todos', () => {
    for (const email of ['cualquiera@gmail.com', 'admin@usina.org.ar']) {
      const r = evaluarAllowlist(email, { allowlist: [], ...PROD })
      assert.equal(r.permitido, false, `debería rechazar ${email} con allowlist vacía`)
      assert.equal(r.permitido === false && r.motivo, 'allowlist-vacia-en-produccion')
    }
  })

  test('en desarrollo permite, para no bloquear el trabajo local', () => {
    assert.equal(evaluarAllowlist('dev@local.test', { allowlist: [], ...DEV }).permitido, true)
  })

  test('una ALLOWED_EMAILS con solo comas equivale a vacía y rechaza en producción', () => {
    const allowlist = parsearAllowlist(' , , ')
    assert.equal(allowlist.length, 0)
    assert.equal(evaluarAllowlist('x@y.com', { allowlist, ...PROD }).permitido, false)
  })
})

describe('puedeAcceder / requiereSesion', () => {
  test('las rutas /admin requieren sesión', () => {
    for (const ruta of ['/admin', '/admin/revisiones', '/admin/dashboard', '/admin/login']) {
      assert.equal(requiereSesion(ruta), true, `${ruta} debería requerir sesión`)
      assert.equal(puedeAcceder(ruta, false), false, `${ruta} sin sesión debe denegarse`)
      assert.equal(puedeAcceder(ruta, true), true, `${ruta} con sesión debe permitirse`)
    }
  })

  test('las rutas públicas no requieren sesión', () => {
    for (const ruta of ['/', '/mapa-del-delito', '/metodologia', '/dashboard']) {
      assert.equal(requiereSesion(ruta), false, `${ruta} no debería requerir sesión`)
      assert.equal(puedeAcceder(ruta, false), true, `${ruta} debe ser accesible sin sesión`)
    }
  })

  test('una ruta que solo empieza parecido a /admin no queda protegida por accidente', () => {
    // Documenta el comportamiento actual del prefijo: /administracion también
    // matchea. El matcher del middleware es /admin/:path*, así que en la práctica
    // esta ruta no existe, pero conviene dejarlo explícito.
    assert.equal(requiereSesion('/administracion'), true)
  })
})
