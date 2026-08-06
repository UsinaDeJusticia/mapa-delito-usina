# Tests

Runner: el test runner nativo de Node (`node:test`) con `tsx` como loader de
TypeScript. Se eligió sobre Vitest para no incorporar `vite` y su árbol de
dependencias en un proyecto cuyo objetivo inmediato es reducir superficie de
riesgo. La única dependencia nueva es `jsdom`, necesaria para verificar sobre
un DOM real que los InfoWindows no interpretan HTML no confiable.

```bash
npm test              # corre todo
npm run test:watch    # modo watch
npm run typecheck     # tsc --noEmit
```

Convención: `tests/<area>/<archivo>.test.ts`, espejando `src/`.

## Tests de Python

Los scripts de ingesta son Python, así que sus tests también. Usan `unittest`
de la biblioteca estándar —sin dependencias— y viven en `tests/ingesta/`:

```bash
npm run test:catalogo   # python -m unittest discover -s tests/ingesta
```

`tests/ingesta/fixtures/` tiene CSV chicos que imitan la estructura del archivo
oficial del SNIC (separador `;`, faltantes como `-`, `s/d` y `...`). El CSV real
pesa cientos de MB y está en `.gitignore`, así que los tests nunca dependen de
que esté presente.

Los tests no tocan la base de datos, no hacen red y no ejecutan el pipeline.
Toda frontera externa (LLM, shell, DOM) se prueba con dobles.
