import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { envOverride } from '../../src/config/modelos-pipeline'

// ════════════════════════════════════════════
// envOverride
// ════════════════════════════════════════════
//
// Regresión real: en GitHub Actions, `${{ secrets.X }}` sobre un secret que
// nunca se configuró se resuelve como cadena vacía, no como ausente. El
// código usaba `process.env.X ?? porDefecto`, que solo reemplaza null/
// undefined — así que OPENCODE_MODELO_ECONOMICO llegaba como `''` y el
// pipeline le pedía a OpenCode Go el modelo `''`. Confirmado en producción:
// las ~45 corridas por medio fallaron con "401 Model  is not supported"
// (nombre vacío) en la primera corrida real tras destrabar el sandbox de
// Chrome que lo había estado ocultando.

describe('envOverride', () => {
  test('usa el default cuando la variable es undefined', () => {
    assert.equal(envOverride(undefined, 'deepseek-v4-flash'), 'deepseek-v4-flash')
  })

  test('usa el default cuando la variable es cadena vacía — el caso real que rompió producción', () => {
    assert.equal(envOverride('', 'deepseek-v4-flash'), 'deepseek-v4-flash')
  })

  test('usa el default cuando la variable es solo espacios', () => {
    assert.equal(envOverride('   ', 'deepseek-v4-flash'), 'deepseek-v4-flash')
  })

  test('usa el valor cuando está seteado', () => {
    assert.equal(envOverride('deepseek-v4-pro', 'deepseek-v4-flash'), 'deepseek-v4-pro')
  })

  test('recorta espacios del valor seteado', () => {
    assert.equal(envOverride('  deepseek-v4-pro  ', 'deepseek-v4-flash'), 'deepseek-v4-pro')
  })
})
