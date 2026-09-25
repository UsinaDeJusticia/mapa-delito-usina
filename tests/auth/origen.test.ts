/**
 * Chequeo de origen de las mutaciones del panel del pipeline: encolar o
 * cancelar una corrida dispara trabajo en la computadora del equipo, así que
 * además de la sesión se exige que el request venga de la misma página.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { origenPermitido } from '../../src/lib/auth/origen'

function headers(h: Record<string, string>): Headers {
  return new Headers(h)
}

describe('origenPermitido', () => {
  test('acepta un POST desde la misma página', () => {
    assert.equal(
      origenPermitido(headers({ origin: 'https://mapa.usinadejusticia.org.ar', host: 'mapa.usinadejusticia.org.ar' }), 'x'),
      true
    )
  })

  test('rechaza un POST armado desde otro sitio, aunque sea un subdominio hermano', () => {
    assert.equal(
      origenPermitido(headers({ origin: 'https://evil.example', host: 'mapa.usinadejusticia.org.ar' }), 'x'),
      false
    )
    assert.equal(
      origenPermitido(
        headers({ origin: 'https://blog.usinadejusticia.org.ar', host: 'mapa.usinadejusticia.org.ar' }),
        'x'
      ),
      false,
      'SameSite=Lax deja pasar subdominios hermanos: este chequeo no'
    )
  })

  test('detrás de Vercel manda x-forwarded-host', () => {
    assert.equal(
      origenPermitido(
        headers({ origin: 'https://mapa.usinadejusticia.org.ar', host: 'interno.vercel', 'x-forwarded-host': 'mapa.usinadejusticia.org.ar' }),
        'x'
      ),
      true
    )
  })

  test('sin Origin (cliente que no es un navegador) decide la autorización normal', () => {
    assert.equal(origenPermitido(headers({ host: 'localhost:3000' }), 'localhost:3000'), true)
  })

  test('un Origin ilegible se rechaza', () => {
    assert.equal(origenPermitido(headers({ origin: 'null', host: 'localhost:3000' }), 'localhost:3000'), false)
  })
})
