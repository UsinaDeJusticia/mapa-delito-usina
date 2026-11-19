import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { esNoDoloso } from '../../src/lib/mapa/gravedad-hecho'

test('3 (viales) y 4 (culposos) son no dolosos; 1 y 2 no', () => {
  assert.equal(esNoDoloso('3'), true)
  assert.equal(esNoDoloso('4'), true)
  assert.equal(esNoDoloso(' 4 '), true)
  for (const c of ['0', '1', '2', '', null, undefined]) assert.equal(esNoDoloso(c), false, String(c))
})

test('/api/mapa/hechos-medios devuelve el código SNIC para distinguirlos', () => {
  const ruta = readFileSync(path.join(__dirname, '../../src/app/api/mapa/hechos-medios/route.ts'), 'utf-8')
  assert.match(ruta, /td\.codigo_snic/)
})
