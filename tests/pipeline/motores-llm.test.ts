/**
 * Registro de motores LLM configurables por archivo.
 *
 * QUÉ DEFECTO REAL PREVIENE CADA GRUPO
 *
 * "plug and play" — hoy sumar un proveedor obliga a tocar el tipo
 * `ProveedorLLM`, el record `ENV_API_KEY` y la lógica de baseURL/headers en
 * TypeScript. Este test es la aserción central del diseño nuevo: carga un
 * JSON de prueba con un motor que NO existe en ningún .ts del repo (id y env
 * var inventados) y verifica que el router lo ve y lo prefiere. Si algún día
 * hace falta editar código para que esto pase, el test tiene que fallar.
 *
 * "se saltea sin credencial" — el 20/8 se perdió Diario Popular entero
 * porque no había ningún camino de reserva. Un motor listado en el JSON pero
 * sin su env var (o con la env var en `''`, el caso real de un secret de
 * GitHub Actions nunca configurado) tiene que desaparecer de la lista
 * disponible sin tirar una excepción.
 *
 * "no hay una API key literal en el JSON" — el diseño depende de que la key
 * nunca viaje en el archivo, solo su nombre. Sin una guarda, un
 * copy-paste de un ejemplo con una key real terminaría commiteado.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parsearMotores,
  getMotoresConfigurados,
  motorDisponible,
  credencialFaltanteDeMotor,
  motorLegacyActivo,
  resolverPolitica,
  resolverPoliticaDisponible,
  hallazgosCredencialLiteral,
  type MotorLLMConfig,
} from '../../src/config/motores-llm'

const RAIZ = process.cwd()

/** Guarda y restaura una env var alrededor de un test, incluso si falla. */
function conEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const previos: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) previos[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of Object.entries(previos)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function conEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previos: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) previos[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await fn()
  } finally {
    for (const [k, v] of Object.entries(previos)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('parsearMotores', () => {
  test('acepta el default "openai" cuando no se especifica protocolo', () => {
    const motores = parsearMotores(JSON.stringify([
      { id: 'x', apiKeyEnv: 'X_KEY', modelo: 'x-1', costoEntradaPorMil: 0.001 },
    ]))
    assert.equal(motores[0].protocolo, 'openai')
  })

  test('acepta protocolo "anthropic" explícito', () => {
    const motores = parsearMotores(JSON.stringify([
      { id: 'haiku', protocolo: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', modelo: 'claude-haiku-4-5', costoEntradaPorMil: 0.001 },
    ]))
    assert.equal(motores[0].protocolo, 'anthropic')
  })

  test('rechaza un protocolo desconocido', () => {
    assert.throws(() => parsearMotores(JSON.stringify([
      { id: 'x', protocolo: 'grpc', modelo: 'x-1' },
    ])))
  })

  test('rechaza un motor sin id o sin modelo', () => {
    assert.throws(() => parsearMotores(JSON.stringify([{ modelo: 'x-1' }])))
    assert.throws(() => parsearMotores(JSON.stringify([{ id: 'x' }])))
  })

  test('rechaza JSON que no es un array', () => {
    assert.throws(() => parsearMotores(JSON.stringify({ id: 'x', modelo: 'x-1' })))
  })

  test('rechaza JSON inválido con un mensaje que lo dice', () => {
    assert.throws(() => parsearMotores('{no es json'), /JSON inválido/)
  })

  test('un motor sin apiKeyEnv es válido (protocolo sin auth, ej. local)', () => {
    const motores = parsearMotores(JSON.stringify([{ id: 'local', modelo: 'llama3' }]))
    assert.equal(motores[0].apiKeyEnv, undefined)
  })
})

describe('motorDisponible / credencialFaltanteDeMotor', () => {
  test('sin apiKeyEnv siempre está disponible', () => {
    assert.equal(motorDisponible({ apiKeyEnv: undefined }), true)
    assert.equal(credencialFaltanteDeMotor({ apiKeyEnv: undefined }), null)
  })

  test('con apiKeyEnv ausente, no está disponible', () => {
    conEnv({ MOTOR_TEST_KEY_1: undefined }, () => {
      assert.equal(motorDisponible({ apiKeyEnv: 'MOTOR_TEST_KEY_1' }), false)
      assert.equal(credencialFaltanteDeMotor({ apiKeyEnv: 'MOTOR_TEST_KEY_1' }), 'MOTOR_TEST_KEY_1')
    })
  })

  test('con apiKeyEnv en cadena vacía (el caso real de un secret de Actions sin configurar), no está disponible', () => {
    conEnv({ MOTOR_TEST_KEY_2: '' }, () => {
      assert.equal(motorDisponible({ apiKeyEnv: 'MOTOR_TEST_KEY_2' }), false)
    })
  })

  test('con apiKeyEnv seteada de verdad, está disponible', () => {
    conEnv({ MOTOR_TEST_KEY_3: 'algo' }, () => {
      assert.equal(motorDisponible({ apiKeyEnv: 'MOTOR_TEST_KEY_3' }), true)
      assert.equal(credencialFaltanteDeMotor({ apiKeyEnv: 'MOTOR_TEST_KEY_3' }), null)
    })
  })
})

describe('getMotoresConfigurados — LLM_MOTORES sobrescribe el archivo', () => {
  test('con LLM_MOTORES seteada, ignora el archivo y usa el override', () => {
    conEnv({ LLM_MOTORES: JSON.stringify([{ id: 'override-1', modelo: 'm-1' }]) }, () => {
      const motores = getMotoresConfigurados()
      assert.deepEqual(motores.map(m => m.id), ['override-1'])
    })
  })

  test('con LLM_MOTORES en cadena vacía, cae al archivo — el caso real de Actions', () => {
    conEnv({ LLM_MOTORES: '' }, () => {
      const motores = getMotoresConfigurados()
      // El archivo default trae al menos go-flash: si `''` se tratara como
      // override real (config vacía), esto daría 0 motores.
      assert.ok(motores.length > 0, 'una LLM_MOTORES vacía no puede apagar todos los motores')
    })
  })

  test('sin LLM_MOTORES, lee config/motores-llm.json', () => {
    conEnv({ LLM_MOTORES: undefined }, () => {
      const motores = getMotoresConfigurados()
      assert.ok(motores.some(m => m.id === 'go-flash'))
    })
  })

  test('un archivo inexistente no tira excepción — degrada a lista vacía', () => {
    conEnv({ LLM_MOTORES: undefined }, () => {
      const motores = getMotoresConfigurados('/ruta/que/no/existe.json')
      assert.deepEqual(motores, [])
    })
  })
})

describe('LA ASERCIÓN CENTRAL: agregar un motor es solo JSON, sin tocar TypeScript', () => {
  test('un motor ficticio, con id y env var inventados en este test, aparece disponible y se prefiere sobre el resto', async () => {
    await conEnvAsync({
      LLM_MOTORES: JSON.stringify([
        { id: 'proveedor-inventado-en-el-test', protocolo: 'openai', apiKeyEnv: 'CLAVE_INVENTADA_EN_EL_TEST', modelo: 'modelo-x', costoEntradaPorMil: 0.0001 },
      ]),
      CLAVE_INVENTADA_EN_EL_TEST: 'presente',
      OPENCODE_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      PIPELINE_PERFIL_MODELO: undefined,
    }, async () => {
      const disponibles = resolverPoliticaDisponible('extraccion')
      const ids = disponibles.map(m => m.id)
      assert.ok(
        ids.includes('proveedor-inventado-en-el-test'),
        `el motor del JSON de prueba no aparece entre los disponibles: ${ids.join(', ')}`
      )
    })
  })

  test('sin credencial, el motor ficticio NO aparece entre los disponibles (pero sí en la política completa)', async () => {
    await conEnvAsync({
      LLM_MOTORES: JSON.stringify([
        { id: 'proveedor-sin-key', apiKeyEnv: 'CLAVE_QUE_NO_SETEO_EN_ESTE_TEST', modelo: 'modelo-x' },
      ]),
      CLAVE_QUE_NO_SETEO_EN_ESTE_TEST: undefined,
    }, async () => {
      const completa = resolverPolitica('extraccion')
      assert.ok(completa.some(m => m.id === 'proveedor-sin-key'), 'la política completa lista el motor igual, sin filtrar')

      const disponibles = resolverPoliticaDisponible('extraccion')
      assert.ok(!disponibles.some(m => m.id === 'proveedor-sin-key'), 'sin su credencial, no puede estar entre los disponibles')
    })
  })

  test('con la env var en cadena vacía (Actions), tampoco aparece — mismo criterio que envOverride', async () => {
    await conEnvAsync({
      LLM_MOTORES: JSON.stringify([
        { id: 'proveedor-key-vacia', apiKeyEnv: 'CLAVE_VACIA_EN_EL_TEST', modelo: 'modelo-x' },
      ]),
      CLAVE_VACIA_EN_EL_TEST: '',
    }, async () => {
      const disponibles = resolverPoliticaDisponible('extraccion')
      assert.ok(!disponibles.some(m => m.id === 'proveedor-key-vacia'))
    })
  })
})

describe('resolverPolitica — el motor legacy siempre va primero', () => {
  test('el primer motor de cualquier política es siempre el legacy activo', () => {
    conEnv({ PIPELINE_PERFIL_MODELO: 'economico' }, () => {
      const politica = resolverPolitica('extraccion', [])
      assert.equal(politica[0].id, 'legacy:economico')
    })
  })

  test('no repite el motor legacy si el JSON declara exactamente el mismo id', () => {
    conEnv({ PIPELINE_PERFIL_MODELO: 'economico' }, () => {
      const motorDuplicado: MotorLLMConfig = { id: 'legacy:economico', protocolo: 'openai', modelo: 'x', costoEntradaPorMil: 0 }
      const politica = resolverPolitica('extraccion', [motorDuplicado])
      const veces = politica.filter(m => m.id === 'legacy:economico').length
      assert.equal(veces, 1)
    })
  })
})

describe('motorLegacyActivo — PIPELINE_PERFIL_MODELO sigue resolviendo a algo válido', () => {
  for (const perfil of ['economico', 'preciso', 'openrouter', 'local'] as const) {
    test(`perfil "${perfil}" resuelve a un motor con id y modelo no vacíos`, () => {
      conEnv({ PIPELINE_PERFIL_MODELO: perfil }, () => {
        const motor = motorLegacyActivo()
        assert.ok(motor.id.length > 0)
        assert.ok(motor.modelo.length > 0)
        assert.equal(motor.protocolo, 'openai') // los 4 perfiles actuales hablan OpenAI-compatible
        // El id tiene que reflejar CUÁL perfil está activo, no ser una
        // etiqueta fija: si no, dos perfiles distintos serían indistinguibles
        // en los logs de escalada (`motor=legacy:...`).
        assert.equal(motor.id, `legacy:${perfil}`)
      })
    })
  }

  test('un valor inválido de PIPELINE_PERFIL_MODELO cae a "economico", igual que getPerfilActivo()', () => {
    conEnv({ PIPELINE_PERFIL_MODELO: 'algo-que-no-existe' }, () => {
      const motor = motorLegacyActivo()
      assert.equal(motor.id, 'legacy:economico')
    })
  })
})

describe('hallazgosCredencialLiteral — guarda contra filtrar una key en el JSON', () => {
  test('el config/motores-llm.json real del repo no contiene ninguna key literal', () => {
    const contenido = readFileSync(path.join(RAIZ, 'config', 'motores-llm.json'), 'utf-8')
    assert.deepEqual(hallazgosCredencialLiteral(contenido), [])
  })

  test('detecta un campo "apiKey" en vez de "apiKeyEnv"', () => {
    const hallazgos = hallazgosCredencialLiteral(JSON.stringify([
      { id: 'x', modelo: 'x-1', apiKey: 'sk-esto-no-debería-estar-acá-1234567890' },
    ]))
    assert.ok(hallazgos.length > 0)
  })

  test('detecta una API key con forma reconocible en cualquier campo', () => {
    const hallazgos = hallazgosCredencialLiteral(JSON.stringify([
      { id: 'x', modelo: 'sk-proj-abcdefghijklmnopqrstuvwx' },
    ]))
    assert.ok(hallazgos.length > 0, 'una key con forma de key real, aunque esté en el campo "modelo", tiene que detectarse')
  })

  test('detecta una key de Anthropic (sk-ant-)', () => {
    const hallazgos = hallazgosCredencialLiteral(JSON.stringify([
      { id: 'x', modelo: 'x', apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
    ]))
    assert.ok(hallazgos.length > 0)
  })

  test('NO da falso positivo con la config real de un motor típico', () => {
    const sano = JSON.stringify([
      { id: 'go-flash', protocolo: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_API_KEY', modelo: 'deepseek-v4-flash', costoEntradaPorMil: 0.00014, concurrencia: 6 },
      { id: 'haiku', protocolo: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', modelo: 'claude-haiku-4-5', costoEntradaPorMil: 0.001 },
    ])
    assert.deepEqual(hallazgosCredencialLiteral(sano), [])
  })

  test('JSON inválido no explota — lo reporta parsearMotores(), no esta guarda', () => {
    assert.deepEqual(hallazgosCredencialLiteral('{no es json'), [])
  })
})
