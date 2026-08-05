import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { autorizarCron, mensajeRechazo } from '../../src/lib/auth/cron'

const SECRET = 'un-secret-de-cron-suficientemente-largo-123'

describe('autorizarCron — secret ausente o vacío (falla cerrada)', () => {
  // Este es el bug original: `Bearer ${undefined}` producía la cadena literal
  // "Bearer undefined", así que ese header exacto autorizaba la ruta.
  test('rechaza "Bearer undefined" cuando el secret no está configurado', () => {
    const r = autorizarCron('Bearer undefined', undefined)
    assert.equal(r.autorizado, false)
    assert.equal(r.autorizado === false && r.motivo, 'secret-no-configurado')
  })

  test('rechaza cualquier header cuando el secret no está configurado', () => {
    for (const header of [
      'Bearer undefined',
      'Bearer ',
      'Bearer null',
      'Bearer ',
      null,
      undefined,
      'Bearer lo-que-sea',
    ]) {
      assert.equal(
        autorizarCron(header, undefined).autorizado,
        false,
        `debería rechazar ${JSON.stringify(header)} sin secret configurado`
      )
    }
  })

  test('rechaza cuando el secret es cadena vacía', () => {
    assert.equal(autorizarCron('Bearer ', '').autorizado, false)
    assert.equal(autorizarCron('Bearer x', '').autorizado, false)
  })

  test('rechaza cuando el secret es solo espacios', () => {
    const r = autorizarCron('Bearer    ', '   ')
    assert.equal(r.autorizado, false)
    assert.equal(r.autorizado === false && r.motivo, 'secret-no-configurado')
  })
})

describe('autorizarCron — secret incorrecto', () => {
  test('rechaza un secret distinto', () => {
    const r = autorizarCron(`Bearer otro-secret-totalmente-distinto`, SECRET)
    assert.equal(r.autorizado, false)
    assert.equal(r.autorizado === false && r.motivo, 'header-invalido')
  })

  test('rechaza un secret con la misma longitud pero distinto contenido', () => {
    const mismoLargo = 'x'.repeat(SECRET.length)
    assert.equal(autorizarCron(`Bearer ${mismoLargo}`, SECRET).autorizado, false)
  })

  test('rechaza el secret correcto sin el prefijo Bearer', () => {
    const r = autorizarCron(SECRET, SECRET)
    assert.equal(r.autorizado, false)
    assert.equal(r.autorizado === false && r.motivo, 'header-invalido')
  })

  test('rechaza prefijos con otra capitalización o esquema', () => {
    for (const header of [
      `bearer ${SECRET}`,
      `BEARER ${SECRET}`,
      `Basic ${SECRET}`,
      `Token ${SECRET}`,
      `Bearer  ${SECRET}`, // doble espacio
    ]) {
      assert.equal(
        autorizarCron(header, SECRET).autorizado,
        false,
        `debería rechazar ${JSON.stringify(header)}`
      )
    }
  })

  test('rechaza el secret con espacios alrededor', () => {
    assert.equal(autorizarCron(`Bearer ${SECRET} `, SECRET).autorizado, false)
    assert.equal(autorizarCron(`Bearer  ${SECRET}`, SECRET).autorizado, false)
  })

  test('rechaza un prefijo del secret correcto', () => {
    assert.equal(autorizarCron(`Bearer ${SECRET.slice(0, -1)}`, SECRET).autorizado, false)
  })

  test('rechaza el secret con contenido extra al final', () => {
    assert.equal(autorizarCron(`Bearer ${SECRET}extra`, SECRET).autorizado, false)
  })
})

describe('autorizarCron — header ausente', () => {
  test('rechaza null y undefined con secret configurado', () => {
    for (const header of [null, undefined, '']) {
      const r = autorizarCron(header, SECRET)
      assert.equal(r.autorizado, false)
      assert.equal(r.autorizado === false && r.motivo, 'header-ausente')
    }
  })
})

describe('autorizarCron — secret correcto', () => {
  test('autoriza con el secret exacto', () => {
    assert.deepEqual(autorizarCron(`Bearer ${SECRET}`, SECRET), { autorizado: true })
  })

  test('autoriza con un secret que contiene caracteres especiales', () => {
    const raro = 'a+b/c=d_e-f.g~h!i@j#k$l%m^n&o*p'
    assert.equal(autorizarCron(`Bearer ${raro}`, raro).autorizado, true)
  })

  test('autoriza con un secret que contiene caracteres no ASCII', () => {
    const unicode = 'secretó-con-acentos-ñ-y-emoji-🔐-largo'
    assert.equal(autorizarCron(`Bearer ${unicode}`, unicode).autorizado, true)
  })

  test('lee CRON_SECRET del entorno cuando no se pasa el parámetro', () => {
    const previo = process.env.CRON_SECRET
    try {
      process.env.CRON_SECRET = SECRET
      assert.equal(autorizarCron(`Bearer ${SECRET}`).autorizado, true)
      assert.equal(autorizarCron('Bearer incorrecto').autorizado, false)

      delete process.env.CRON_SECRET
      assert.equal(autorizarCron('Bearer undefined').autorizado, false)
    } finally {
      if (previo === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = previo
    }
  })
})

describe('mensajeRechazo', () => {
  test('devuelve un mensaje para cada motivo y nunca incluye el secret', () => {
    const motivos = ['secret-no-configurado', 'header-ausente', 'header-invalido'] as const
    for (const m of motivos) {
      const msg = mensajeRechazo(m)
      assert.ok(msg.length > 0, `motivo ${m} sin mensaje`)
      assert.ok(!msg.includes(SECRET), 'el mensaje no debe filtrar el secret')
    }
  })
})
