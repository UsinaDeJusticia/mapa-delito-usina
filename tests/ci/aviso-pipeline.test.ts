/**
 * Del 17/10 al 18/11/2026 pipeline.yml falló 33 días seguidos y nadie se
 * enteró: el único aviso era un `echo` en el log. Estos tests fijan que una
 * falla de la corrida programada abra (o comente) un issue y que la primera
 * corrida buena lo cierre.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const YML = readFileSync(path.join(__dirname, '../../.github/workflows/pipeline.yml'), 'utf-8')
const AVISO = YML.slice(YML.indexOf('\n  aviso:'))

describe('aviso de pipeline caído en pipeline.yml', () => {
  test('existe un job aviso que depende del pipeline', () => {
    assert.ok(YML.includes('\n  aviso:'), 'falta el job aviso')
    assert.match(AVISO, /needs:\s*pipeline/)
  })

  test('corre siempre, pero solo en la corrida programada', () => {
    assert.match(AVISO, /if:\s*always\(\)\s*&&\s*github\.event_name\s*==\s*'schedule'/)
  })

  test('tiene permiso para escribir issues y nada más', () => {
    assert.match(AVISO, /permissions:\s*\n\s*issues:\s*write/)
    assert.doesNotMatch(AVISO, /contents:\s*write/)
  })

  test('reusa un issue abierto en vez de abrir uno por día, y lo cierra al recuperarse', () => {
    assert.match(AVISO, /labels:\s*ETIQUETA/)
    assert.match(AVISO, /createComment/)
    assert.match(AVISO, /state:\s*'closed'/)
  })

  test('el issue no incluye salida del pipeline (el repo es público)', () => {
    assert.doesNotMatch(AVISO, /secrets\./)
  })
})
