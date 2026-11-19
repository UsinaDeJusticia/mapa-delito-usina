/**
 * El mapa público no debe mostrar casos que el pipeline marcó como dudosos
 * (requiere_revision) hasta que una persona los clasifique.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RUTA = readFileSync(path.join(__dirname, '../../src/app/api/mapa/hechos-medios/route.ts'), 'utf-8')
const REVISIONES = readFileSync(path.join(__dirname, '../../src/app/api/admin/revisiones/route.ts'), 'utf-8')

test('/api/mapa/hechos-medios excluye los casos con requiere_revision', () => {
  assert.match(RUTA, /AND\s+hd\.requiere_revision\s*=\s*false/)
})

test('clasificar en /admin/revisiones limpia requiere_revision, así el pin aparece', () => {
  const limpia = REVISIONES.match(/requiere_revision\s*=\s*false/g) ?? []
  assert.ok(limpia.length >= 2, 'ambas ramas del POST (homicidio / no es homicidio) deben limpiar el flag')
})
