/**
 * La allowlist se revalida en cada request, no solo al iniciar sesión.
 *
 * EL DEFECTO
 * `evaluarAllowlist` solo corría en el callback `signIn`. Después de eso, la
 * autorización se reducía a `!!auth?.user` — o sea "hay un JWT válido". Pero un
 * JWT sigue siendo criptográficamente válido después de que a su dueño se le
 * quitó el acceso: sacar un email de ALLOWED_EMAILS no cerraba la sesión que ya
 * estaba abierta.
 *
 * Y había un segundo agujero, peor: el matcher del middleware es
 * `['/admin/:path*']`, que NO matchea `/api/admin/...`. Las cuatro rutas de API
 * —las que leen la cola de revisión y las que la MODIFICAN— nunca pasaban por
 * el middleware y se autorizaban solas con `!!session?.user`. Ahí están los
 * datos, así que era el agujero que más importaba.
 *
 * Los tests de abajo cubren las dos mitades: la lógica pura de revalidación, y
 * una guarda estructural que falla si alguna ruta admin vuelve a autorizarse
 * sin pasar por `requerirAdmin()`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  sesionSigueAutorizada,
  contextoDesdeEnv,
} from '../../src/lib/auth/allowlist'

const RAIZ = process.cwd()
const DIR_API_ADMIN = path.join(RAIZ, 'src/app/api/admin')

/**
 * Corre una función con ALLOWED_EMAILS y NODE_ENV puestos, y los restaura.
 *
 * Asignación directa sobre un env casteado, no Object.defineProperty: Node
 * rechaza un descriptor que no sea configurable, writable y enumerable a la vez
 * sobre process.env, y NODE_ENV viene tipada como readonly en TypeScript.
 */
const env = process.env as Record<string, string | undefined>

function conEntorno<T>(
  vars: { ALLOWED_EMAILS?: string; NODE_ENV?: string },
  fn: () => T
): T {
  const previo = { ALLOWED_EMAILS: env.ALLOWED_EMAILS, NODE_ENV: env.NODE_ENV }
  const restaurar = (clave: 'ALLOWED_EMAILS' | 'NODE_ENV', valor: string | undefined) => {
    if (valor === undefined) delete env[clave]
    else env[clave] = valor
  }

  try {
    restaurar('ALLOWED_EMAILS', vars.ALLOWED_EMAILS)
    if (vars.NODE_ENV !== undefined) env.NODE_ENV = vars.NODE_ENV
    return fn()
  } finally {
    restaurar('ALLOWED_EMAILS', previo.ALLOWED_EMAILS)
    restaurar('NODE_ENV', previo.NODE_ENV)
  }
}

describe('sesionSigueAutorizada', () => {
  test('acepta a quien sigue en la lista', () => {
    conEntorno({ ALLOWED_EMAILS: 'ana@usina.org,juan@usina.org' }, () => {
      assert.equal(sesionSigueAutorizada('ana@usina.org'), true)
    })
  })

  test('rechaza a quien fue sacado de la lista — el caso que motivó el fix', () => {
    // Misma sesión, misma persona: lo único que cambió es la allowlist.
    conEntorno({ ALLOWED_EMAILS: 'ana@usina.org,juan@usina.org' }, () => {
      assert.equal(sesionSigueAutorizada('juan@usina.org'), true)
    })
    conEntorno({ ALLOWED_EMAILS: 'ana@usina.org' }, () => {
      assert.equal(
        sesionSigueAutorizada('juan@usina.org'),
        false,
        'una sesión ya emitida tiene que dejar de valer cuando se revoca el acceso'
      )
    })
  })

  test('normaliza igual que al iniciar sesión (mayúsculas y espacios)', () => {
    conEntorno({ ALLOWED_EMAILS: 'ana@usina.org' }, () => {
      assert.equal(sesionSigueAutorizada('  ANA@Usina.ORG  '), true)
    })
  })

  test('rechaza sesión sin email', () => {
    conEntorno({ ALLOWED_EMAILS: 'ana@usina.org' }, () => {
      assert.equal(sesionSigueAutorizada(null), false)
      assert.equal(sesionSigueAutorizada(undefined), false)
      assert.equal(sesionSigueAutorizada(''), false)
    })
  })

  test('con allowlist vacía falla cerrada en producción', () => {
    conEntorno({ ALLOWED_EMAILS: '', NODE_ENV: 'production' }, () => {
      assert.equal(sesionSigueAutorizada('quien@sea.org'), false)
    })
  })

  test('acepta un contexto explícito, para poder testear sin tocar el entorno', () => {
    assert.equal(
      sesionSigueAutorizada('ana@usina.org', {
        allowlist: ['ana@usina.org'],
        esProduccion: true,
      }),
      true
    )
  })
})

describe('contextoDesdeEnv se lee en cada llamada', () => {
  test('refleja un cambio de ALLOWED_EMAILS sin reiniciar el módulo', () => {
    // Si la allowlist quedara cacheada en una constante de módulo, este test
    // fallaría: era exactamente por eso que la revocación no surtía efecto.
    conEntorno({ ALLOWED_EMAILS: 'uno@x.org' }, () => {
      assert.deepEqual(contextoDesdeEnv().allowlist, ['uno@x.org'])
    })
    conEntorno({ ALLOWED_EMAILS: 'dos@x.org,tres@x.org' }, () => {
      assert.deepEqual(contextoDesdeEnv().allowlist, ['dos@x.org', 'tres@x.org'])
    })
  })
})

// ════════════════════════════════════════════
// GUARDA ESTRUCTURAL
// ════════════════════════════════════════════

/** Todos los route.ts bajo src/app/api/admin, recursivo. */
function rutasAdmin(dir = DIR_API_ADMIN, acumulado: string[] = []): string[] {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name)
    if (entrada.isDirectory()) rutasAdmin(completo, acumulado)
    else if (entrada.name === 'route.ts') acumulado.push(completo)
  }
  return acumulado
}

describe('ninguna ruta admin se autoriza sola', () => {
  const rutas = rutasAdmin()

  test('hay rutas para revisar (si no, el resto de la guarda es vacuo)', () => {
    assert.ok(rutas.length >= 4, `esperaba al menos 4 rutas admin, encontré ${rutas.length}`)
  })

  for (const ruta of rutas) {
    const rel = path.relative(RAIZ, ruta)
    const contenido = readFileSync(ruta, 'utf-8')

    test(`${rel} usa requerirAdmin()`, () => {
      assert.match(
        contenido,
        /requerirAdmin\(\)/,
        `${rel} tiene que autorizar con requerirAdmin(), que revalida la allowlist`
      )
    })

    test(`${rel} no llama a auth() directamente`, () => {
      // auth() solo dice "hay sesión válida", no "sigue autorizado". El
      // middleware no cubre /api/admin/*, así que acá esa diferencia es todo.
      assert.ok(
        !/\bawait auth\(\)/.test(contenido),
        `${rel} volvió a usar auth() directo: una sesión revocada seguiría entrando`
      )
    })
  }
})

describe('el middleware sigue sin cubrir /api/admin, y por eso hace falta el helper', () => {
  test('el matcher no matchea las rutas de API', () => {
    // Si algún día se extiende el matcher, revisar el comentario de
    // src/lib/auth/admin.ts: cubrir /api/admin/* con el middleware haría que un
    // fetch reciba un redirect 302 a HTML donde espera un 401 JSON.
    const middleware = readFileSync(path.join(RAIZ, 'src/middleware.ts'), 'utf-8')
    assert.match(middleware, /matcher:\s*\[\s*'\/admin\/:path\*'\s*\]/)
  })

  test('authorized revalida la allowlist, no solo la existencia de sesión', () => {
    const authTs = readFileSync(path.join(RAIZ, 'src/auth.ts'), 'utf-8')
    assert.match(
      authTs,
      /sesionSigueAutorizada/,
      'el callback authorized tiene que revalidar, no solo mirar !!auth?.user'
    )
  })
})
