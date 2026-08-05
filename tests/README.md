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

Los tests no tocan la base de datos, no hacen red y no ejecutan el pipeline.
Toda frontera externa (LLM, shell, DOM) se prueba con dobles.
