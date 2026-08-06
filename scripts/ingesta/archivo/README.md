# Archivo — scripts que ya no forman parte de ningún flujo

Lo que está en esta carpeta **no se ejecuta**. Se conserva por su valor
histórico: documenta cómo se cargaron los datos en algún momento y a veces
explica de dónde salió una decisión que hoy parece arbitraria.

Si algo de acá vuelve a hacer falta, **no lo ejecutes tal cual**. Leelo,
comparalo contra el esquema actual y contra las convenciones vigentes de
`CLAUDE.md`, y recién entonces reescribilo en `scripts/ingesta/`.

---

## `cargar-snic.ts`

Ingesta de CSV del SNIC a `EstadisticaAgregada`, escrita en TypeScript.
Última modificación: marzo de 2026.

**Por qué está archivado.** Nada lo invoca. No hay script de `package.json` que
lo llame, y `scripts/ingesta/run_ingesta.sh` —el orquestador real de la
ingesta— usa los dos scripts de Python:

```
run_ingesta.sh → snic-departamentos.py   (SNIC → EstadisticaAgregada)
               → sat-homicidios.py       (SAT  → HechoDelictivo + Ubicacion)
```

`snic-departamentos.py` cubre el mismo terreno que este archivo. Tener las dos
implementaciones a la vista invita al error de correr la que no corresponde, o
de arreglar un bug en una y no en la otra.

**Qué habría que revisar antes de revivirlo.** Dos cosas que hoy están mal
según las convenciones del repo:

1. **Instancia su propio `PrismaClient`.** `CLAUDE.md` pide usar el singleton de
   `@/lib/mapa/queries`; abrir clientes sueltos agota el pool de conexiones de
   Neon.
2. **Tiene su propia tabla de centroides provinciales**, distinta de la de
   `src/lib/mapa/queries.ts`. Dos fuentes de verdad para las mismas 24
   coordenadas, que ya divergieron entre sí.

**Sigue entrando al `tsc --noEmit`.** A propósito: mientras compile, no molesta,
y el día que un cambio de esquema lo rompa eso es información útil —significa
que quedó definitivamente obsoleto y conviene borrarlo, no arreglarlo.
