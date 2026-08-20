/**
 * El circuito de aprendizaje queda cerrado: ahora se puede marcar un caso como
 * ejemplo curado desde el panel.
 *
 * EL ESTADO ANTERIOR
 * `usar_como_ejemplo` existía en el schema desde el principio con DEFAULT false,
 * y getFewShotEjemplos() ya la leía y priorizaba (openrouter.ts). Pero **nada en
 * todo el repo la escribía**: el único modo de setearla era editar la base a
 * mano. O sea que la mitad de lectura del mecanismo funcionaba contra una
 * columna que siempre valía false.
 *
 * DECISIÓN DE SEMÁNTICA
 * La marca es por REVISIÓN, no por hecho, y se deja así. Si alguien marca un
 * caso como buen ejemplo y después otro corrige la clasificación, la fila nueva
 * nace en false y el ejemplo curado se pierde. Eso es lo correcto: si la
 * clasificación estaba mal, ese caso no era un buen ejemplo. No se propaga a
 * propósito.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAIZ = process.cwd()
const leer = (rel: string) => readFileSync(path.join(RAIZ, rel), 'utf-8')

function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('--') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

const ROUTE = leer('src/app/api/admin/revisiones/route.ts')
const PAGE = leer('src/app/admin/revisiones/page.tsx')

describe('el endpoint de escritura existe', () => {
  test('hay un PATCH exportado', () => {
    assert.match(ROUTE, /export async function PATCH/)
  })

  test('exige autenticación con requerirAdmin', () => {
    // Hay una guarda estructural en tests/auth/allowlist-por-request.test.ts
    // que ya cubre esto para el archivo entero; se afirma acá también porque el
    // PATCH escribe.
    const patch = ROUTE.slice(ROUTE.indexOf('export async function PATCH'))
    assert.match(patch, /await requerirAdmin\(\)/)
    assert.ok(
      !/\bawait auth\(\)/.test(patch),
      'auth() solo dice "hay sesión", no "sigue autorizado"'
    )
  })

  test('valida el body: hecho_id y un boolean', () => {
    const patch = ROUTE.slice(ROUTE.indexOf('export async function PATCH'))
    assert.match(patch, /typeof usar_como_ejemplo !== 'boolean'/)
    assert.match(patch, /status: 400/)
  })

  test('actualiza SOLO la revisión más reciente del hecho', () => {
    // Sin la subconsulta se marcarían también las clasificaciones ya superadas
    // de ese hecho — justo lo que el few-shot no debe resucitar.
    // Verificado además contra Postgres real: con dos revisiones de un mismo
    // hecho, queda marcada la última y la anterior sigue en false.
    const patch = sinComentarios(ROUTE.slice(ROUTE.indexOf('export async function PATCH')))
    assert.match(patch, /ORDER BY revisado_at DESC\s*\n?\s*LIMIT 1/)
  })

  test('devuelve 404 si el hecho no tiene ninguna revisión', () => {
    const patch = ROUTE.slice(ROUTE.indexOf('export async function PATCH'))
    assert.match(patch, /status: 404/)
  })

  test('no cachea la respuesta', () => {
    const patch = ROUTE.slice(ROUTE.indexOf('export async function PATCH'))
    assert.match(patch, /'Cache-Control': 'no-store'/)
  })
})

describe('el GET devuelve el estado del flag', () => {
  test('lo selecciona en la consulta de revisados', () => {
    // Sin esto el toggle arrancaría siempre apagado, aunque el caso estuviera
    // marcado en la base.
    assert.match(ROUTE, /COALESCE\(rp\.usar_como_ejemplo, false\) AS usar_como_ejemplo/)
  })

  test('lo incluye en la respuesta JSON', () => {
    assert.match(ROUTE, /usar_como_ejemplo: Boolean\(r\.usar_como_ejemplo\)/)
  })

  test('usa COALESCE porque la columna es nullable', () => {
    // DEFAULT false pero sin NOT NULL: las filas viejas pueden tener null.
    const sql = leer('scripts/sql/create-revisiones-pipeline.sql')
    assert.match(sql, /usar_como_ejemplo BOOLEAN DEFAULT false/)
    assert.ok(!/usar_como_ejemplo BOOLEAN NOT NULL/.test(sql))
  })
})

describe('la UI ofrece el toggle', () => {
  test('CardRevisado tiene el botón y llama al PATCH', () => {
    assert.match(PAGE, /method: 'PATCH'/)
    assert.match(PAGE, /usar_como_ejemplo: nuevo/)
  })

  test('es accesible: aria-pressed refleja el estado', () => {
    assert.match(PAGE, /aria-pressed=\{ejemplo\}/)
  })

  test('revierte el estado optimista si el PATCH falla', () => {
    // Sin esto, la estrella queda encendida aunque no se haya guardado nada.
    assert.match(PAGE, /setEjemplo\(!nuevo\)/)
  })

  test('el tooltip avisa de la demora de la caché', () => {
    // FEW_SHOT_TTL_MS son 5 minutos de caché en memoria del pipeline, y no se
    // invalida entre procesos. Marcar un ejemplo no surte efecto al instante.
    assert.match(PAGE, /5 min/)
  })

  test('el padre sincroniza el estado para que el polling no lo pise', () => {
    // Hay un polling de 30s y un SSE que recargan `revisados`. Sin propagar la
    // marca al estado del padre, el próximo refresco la revertiría visualmente.
    assert.match(PAGE, /function handleMarcarEjemplo/)
    assert.match(PAGE, /onMarcarEjemplo=\{handleMarcarEjemplo\}/)
  })
})

describe('la lectura del few-shot sigue en pie', () => {
  test('getFewShotEjemplos prioriza los marcados', () => {
    // Es la otra mitad del circuito: si esto se cae, marcar no sirve de nada.
    const openrouter = leer('src/lib/mapa/openrouter.ts')
    assert.match(openrouter, /ORDER BY usar_como_ejemplo DESC,\s*revisado_at DESC/)
  })
})
