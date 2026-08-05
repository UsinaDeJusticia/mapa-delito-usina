# Plan de seguridad, performance y mantenibilidad

Fecha del analisis: 2026-08-05
Repositorio: `UsinaDeJusticia/mapa-delito-usina`
Commit base analizado: `d7bd8ea7ffcdb72a9eca499338649f0e40d08512`

## Objetivo

Elevar el proyecto a un nivel sostenible de seguridad, integridad de datos,
performance, mantenibilidad y operacion. El orden de implementacion es
intencional: primero se eliminan riesgos de ejecucion y corrupcion de datos;
despues se optimiza y refactoriza.

## Resumen ejecutivo

La aplicacion funciona, pero el analisis encontro riesgos importantes en cuatro
areas:

1. Entradas controladas por sitios y modelos pueden alcanzar un shell o HTML.
2. Las dependencias principales tienen vulnerabilidades criticas y altas.
3. Existen errores silenciosos en clasificacion, ingesta y separacion de fuentes.
4. La carga inicial del mapa es excesiva para el caso de uso mobile 4G.

`npm audit` reporto 15 vulnerabilidades: 2 criticas, 12 altas y 1 baja.

## Hallazgos criticos y altos

### 1. Ejecucion de comandos desde datos del LLM

Referencias:

- `scripts/pipeline/scrapear-medios.ts:212-218`
- `scripts/pipeline/scrapear-medios.ts:295-302`
- `scripts/pipeline/scrapear-medios.ts:387-396`

`agentCmd()` concatena un string y lo ejecuta mediante `execSync`. El `ref`
elegido por el LLM puede llegar a ese string sin validacion runtime. Un snapshot
hostil puede inducir metacaracteres de shell.

Correccion:

- Reemplazar `execSync(string)` por `spawn` o `execFile` con argumentos.
- Usar `shell: false`.
- Validar referencias con un patron estricto, por ejemplo `^e[0-9]+$`.
- Validar toda respuesta LLM mediante schema runtime.
- Ejecutar browser automation con ambiente minimo y sin secretos innecesarios.

### 2. Auth.js vulnerable

Referencias:

- `package.json:28`

`next-auth@5.0.0-beta.31` usa `@auth/core@0.41.2`, afectado por advisories
criticos. `next-auth@5.0.0-beta.32` usa `@auth/core@0.41.3`, que contiene las
correcciones reportadas.

Correccion:

- Fijar exactamente `next-auth@5.0.0-beta.32`.
- Regenerar `package-lock.json` con npm.
- Probar sesiones validas, errores del proveedor, headers malformed y emails
  Unicode.
- Validar usuario y allowlist en cada request admin, no solo durante `signIn`.

### 3. Next.js vulnerable

Referencias:

- `package.json:27`

Next.js 14.2.35 aparece afectado por multiples advisories altos. La migracion a
una version soportada debe hacerse en una rama dedicada porque puede implicar
React 19 y cambios de App Router/middleware.

Correccion:

- Definir una version objetivo soportada y parcheada.
- Actualizar `next` y `eslint-config-next` juntos.
- Verificar middleware, Auth.js, rutas dinamicas, caching y build de Vercel.

### 4. XSS almacenado en InfoWindows

Referencias:

- `src/components/mapa/capas/CapaHechosMedios.tsx:86-109`
- `src/components/mapa/capas/MarcadoresCirculares.tsx:107-140`
- `src/components/mapa/capas/CapaH3.tsx:93`

Los InfoWindows se construyen con strings HTML que incluyen titulo, medio,
ubicacion y URL procedentes de scraping/base de datos.

Correccion:

- Construir elementos con `document.createElement`.
- Asignar datos no confiables exclusivamente mediante `textContent`.
- Validar URLs con `new URL()` y permitir solo `https:`; admitir `http:` solo
  cuando sea imprescindible.
- Agregar CSP en modo report-only y luego enforcement.

### 5. SSRF desde enlaces de medios

Referencias:

- `scripts/pipeline/scrapear-medios.ts:238-302`
- `scripts/pipeline/scrapear-medios.ts:347-452`

El browser puede seguir links elegidos por el LLM sin validar dominio, protocolo,
redirects ni IP final.

Correccion:

- Permitir solo HTTPS.
- Limitar navegacion al dominio registrable del medio y subdominios aprobados.
- Revalidar cada redirect.
- Bloquear loopback, RFC1918, link-local, metadata y esquemas no HTTP.
- Aplicar controles de egress en el entorno del worker.

### 6. Prompt injection y respuestas LLM no validadas

Referencias:

- `src/lib/mapa/openrouter.ts:69-105`
- `src/lib/mapa/openrouter.ts:200-250`
- `src/lib/mapa/deduplicador.ts:143-188`
- `scripts/pipeline/scrapear-medios.ts:247-303`

Los casts TypeScript no validan JSON en runtime. Fechas, confianza, cantidades,
clasificaciones, URLs y `candidatoId` pueden ser arbitrarios. Los ejemplos
few-shot tampoco verifican `usar_como_ejemplo`.

Correccion:

- Incorporar schemas runtime compartidos.
- Validar enums, longitudes, rangos, fechas y cantidades.
- Exigir que `candidatoId` pertenezca al conjunto enviado al modelo.
- Usar solamente ejemplos explicitamente aprobados.
- Separar errores del proveedor de decisiones negativas del modelo.

### 7. Clasificacion SNIC incorrecta

Referencias:

- `src/lib/mapa/openrouter.ts:75-81`
- `prisma/seed.ts:10-14`
- `scripts/pipeline/scrapear-medios.ts:674-683`

El prompt define codigo 3 como homicidio culposo general y codigo 4 como
femicidio. El catalogo oficial define 3 como muertes viales y 4 como homicidios
culposos por otros hechos. Femicidio no debe reutilizar el codigo SNIC 4.

Correccion:

- Crear un catalogo de dominio canonico.
- Separar clasificacion interna, codigo SNIC y flag femicidio.
- Representar causa dudosa como estado interno, no como codigo SNIC 0.
- Agregar tests de mapeo antes de persistir.

### 8. Ingesta SNIC mezcla hechos y victimas

Referencias:

- `scripts/ingesta/cargar-snic.ts:63-82`
- `scripts/ingesta/cargar-snic.ts:169-181`
- `scripts/ingesta/cargar-snic.ts:203-222`

Columnas `_hechos` y `_victimas` se transforman en registros separados usando
`cantidadHechos`; `cantidadVictimas` no se completa. El mismo ID logico puede
sobrescribirse segun el orden de columnas.

Correccion:

- Agrupar primero por anio, provincia y delito.
- Poblar separadamente hechos y victimas.
- Rechazar claves logicas duplicadas.
- Agregar fixtures de CSV y reconciliacion contra totales oficiales.

### 9. Ingesta SAT descarta campos detallados

Referencias:

- `scripts/ingesta/sat-homicidios.py:473-486`

`HECHO_COLS` contiene identificadores SQL con comillas, pero esos mismos strings
se usan como claves del diccionario. Campos como sexo, medio, vinculo y contexto
terminan en `NULL`.

Correccion:

- Separar `(clave_datos, identificador_sql)`.
- Agregar aserciones pre-insert y reconciliacion posterior.
- Corregir tambien `codigo_snic = 1` por parametro string `'1'`.

### 10. Contaminacion de vistas SAT

Referencias:

- `scripts/sql/mv_sat_provincia.sql:11-16`
- `scripts/sql/create-materialized-views.sql:76-90`
- `scripts/export/export_parquet.sql:61-84`

El criterio `es_agregado = false` incluye tanto SAT como pipeline periodistico.
Esto puede mezclar datos oficiales y periodisticos y duplicar hechos.

Correccion:

- Filtrar por un codigo de fuente estable.
- No usar nombres de display como identidad de fuente.
- Reconciliar vistas contra totales SAT oficiales.

### 11. Datos sensibles publicos

Referencias:

- `scripts/export/export_parquet.sql:61-84`
- `public/data/hechos_sat.parquet`
- `src/app/api/mapa/hechos-medios/route.ts`

El Parquet publico contiene UUID, coordenadas, sexo, arma, vinculo, femicidio,
subtipo y contexto. La combinacion puede permitir reidentificacion.

Recomendacion:

- Retirar microdatos publicos.
- Servir agregados por provincia o H3.
- Suprimir celdas con conteos pequenos.
- Excluir preliminares de datasets publicos.
- Eliminar IDs internos y coordenadas exactas.

### 12. Revision admin debilmente validada

Referencias:

- `src/app/api/admin/revisiones/route.ts:201-265`

Una clasificacion desconocida se trata como rechazo. La insercion de auditoria y
la actualizacion del hecho no son atomicas. Tampoco se limita el universo de
hechos modificables.

Correccion:

- Validar body y UUID mediante schema runtime.
- Permitir solo clasificaciones registradas.
- Verificar elegibilidad del hecho.
- Ejecutar historial y actualizacion en una transaccion.
- Incorporar control de concurrencia/optimistic locking.

### 13. Refresh de vistas falla abierto

Referencia:

- `src/app/api/pipeline/refresh-views/route.ts:5-13`

Si `CRON_SECRET` no existe, `Bearer undefined` puede autorizar la ruta.

Correccion:

- Centralizar `authorizeCron()`.
- Rechazar secrets vacios.
- Agregar lock para impedir refreshes simultaneos.
- Aplicar `no-store` a todas las respuestas.

### 14. Schema no reproducible

Referencias:

- `prisma/schema.prisma`
- `scripts/sql/create-revisiones-pipeline.sql`
- `scripts/sql/create-feedback.sql`
- `scripts/sql/create-materialized-views.sql`

No hay migracion versionada para `requiere_revision`, y tablas/vistas requeridas
viven fuera de Prisma. Una base vacia no puede reconstruirse solo desde el repo.

Correccion:

- Elegir un unico sistema de migraciones o documentar formalmente dos capas.
- Llevar tablas, columnas e indices requeridos a migraciones ordenadas.
- Agregar CI con `prisma migrate diff` y prueba sobre base vacia.

### 15. Credencial antigua trackeada

Referencia:

- `schema-neon.js`

El archivo contiene una URL PostgreSQL de propietario. Se verifico que la
credencial ya no conecta (`28P01`) y que es distinta de la credencial actual.
No requiere otra rotacion, pero debe eliminarse del branch actual y mantenerse
revocada en el historial.

## Performance medido

### Ruta critica mobile

- JS especifico de `/mapa-del-delito`: aproximadamente 1.13 MB raw / 317 KB gzip.
- Recharts: aproximadamente 163 KB gzip, cargado antes de abrir el panel.
- DuckDB MVP WASM: aproximadamente 37.5 MB.
- DuckDB EH WASM: aproximadamente 32.7 MB.
- H3: aproximadamente 55 KB gzip, aunque la capa inicia apagada.
- Fuentes Geist: aproximadamente 134 KB descargados pero no usados por el body.

### Problemas principales

1. `useMapaData` espera que DuckDB termine de cargar antes de usar la API.
2. DuckDB bloquea la primera visualizacion entre 20 y 60 segundos en 4G.
3. `PanelEstadisticas` carga Recharts en el bundle inicial.
4. Hasta 500 markers usan `optimized: false` y no tienen clustering.
5. El slider genera multiples requests durante el arrastre.
6. Arrays derivados se recrean en cada hover y reestilizan provincias.
7. El endpoint de hechos envia mas campos de los necesarios para dibujar pins.
8. Tendencias carece de indice `(tipo_delito_id, provincia_id, anio)`.
9. Varias queries hacen round trips seriales evitables.
10. SSE consulta la base cada cuatro segundos por cliente y puede solaparse.

## Mantenibilidad

1. `scripts/pipeline/scrapear-medios.ts` tiene aproximadamente 859 lineas y
   mezcla configuracion, browser, LLM, georef, persistencia y orquestacion.
2. `src/components/mapa/MapaDelito.tsx` tiene aproximadamente 629 lineas y mezcla
   navegacion, estado, responsive, capas, timers y fetching.
3. `src/lib/mapa/queries.ts` combina cliente, repositorios, SQL, configuracion y
   mapeo de DTOs.
4. Existen dos Prisma clients dentro del proceso del pipeline.
5. Tipos API y de mapa estan duplicados y algunos contradicen Prisma.
6. JSON externo se acepta mediante casts en vez de validacion runtime.
7. No existen tests automatizados ni CI de calidad para pull requests.
8. `README.md` sigue siendo el boilerplate de Create Next App.
9. Documentacion de medios, proveedores y autenticacion contiene drift.
10. `PIPELINE_MAX_NOTICIAS` se loguea pero el codigo usa `slice(0, 10)`.
11. Vercel y GitHub Actions intentan programar el mismo pipeline en plataformas
    con capacidades distintas.
12. Runtime, migraciones, ingesta y export usan una credencial propietaria.

# Plan de implementacion

## Fase 0 - Contencion inmediata

Duracion estimada: 1 a 2 dias.

1. Eliminar `schema-neon.js` del branch actual.
2. Corregir fail-open de `refresh-views`.
3. Reemplazar comandos shell por procesos con argumentos y `shell: false`.
4. Validar refs y respuestas del LLM.
5. Corregir XSS en todos los InfoWindows.
6. Fijar `next-auth@5.0.0-beta.32` y regenerar lockfile con npm.
7. Crear tests de autenticacion, refs hostiles y URLs peligrosas.
8. Habilitar secret scanning y push protection.

Criterio de salida:

- Ningun dato externo llega a shell o HTML sin validacion.
- Auth.js deja de aparecer como critical en `npm audit`.
- Todas las rutas cron fallan cerradas.

## Fase 1 - Integridad de datos

Duracion estimada: 3 a 5 dias.

1. Crear catalogo canonico de clasificacion delictiva.
2. Separar clase interna, codigo SNIC y femicidio.
3. Corregir ingesta SNIC de hechos/victimas.
4. Corregir columnas SAT y lookup de codigo SNIC.
5. Unificar fuentes mediante codigos estables.
6. Filtrar vistas SAT por fuente real.
7. Crear migracion para `requiere_revision`.
8. Versionar tablas, vistas e indices requeridos.
9. Ejecutar reconciliacion de datos existentes.
10. Reimportar o backfillear datos afectados si la reconciliacion falla.

Criterio de salida:

- Una base vacia puede reconstruirse desde control de versiones.
- Los totales coinciden con las fuentes oficiales.
- Los campos SAT esperados no quedan sistematicamente en NULL.

## Fase 2 - Privacidad publica

Duracion estimada: 2 a 4 dias.

1. Retirar o restringir `hechos_sat.parquet`.
2. Eliminar UUID internos de datasets publicos.
3. Sustituir coordenadas por agregados H3.
4. Aplicar supresion minima por celda.
5. Excluir preliminares de respuestas publicas.
6. Documentar politica de publicacion y retencion.
7. Validar URLs durante ingesta y render.

Criterio de salida:

- Los archivos publicos no permiten identificar facilmente victimas o domicilios.
- Toda publicacion tiene una fuente y nivel de confianza explicitos.

## Fase 3 - Autenticacion y APIs

Duracion estimada: 3 a 5 dias.

1. Crear `requireAdmin()` centralizado.
2. Validar allowlist en cada request.
3. Agregar schemas runtime compartidos.
4. Transaccionar revision e historial.
5. Agregar control de concurrencia para revisiones.
6. Limitar mensajes, notas, fechas y parametros.
7. Acotar SSE por cursor, lookback y conexiones.
8. Agregar rate limiting distribuido.
9. Aplicar `no-store` consistente.
10. Incorporar CSP primero en report-only.

## Fase 4 - Performance web

Duracion estimada: 3 a 5 dias.

1. Mostrar datos desde API inmediatamente.
2. Inicializar DuckDB despues de la primera pintura o eliminarlo.
3. Cargar dinamicamente `PanelEstadisticas` y `CapaH3`.
4. Habilitar clustering y markers optimizados.
5. Debouncear el slider de anios.
6. Mantener datos anteriores durante recarga.
7. Memorizar arrays derivados.
8. Usar realmente Geist o dejar de descargarlo.
9. Reducir payload de hechos-medios.
10. Agregar indice de tendencias y reducir round trips.

Objetivos:

- Primera visualizacion en 4G menor a 2.5 segundos.
- JS inicial del mapa menor a 180 KB gzip.
- Sin WASM en la ruta critica.
- Un request por cambio confirmado de anio.

## Fase 5 - Pipeline resiliente

Duracion estimada: 5 a 8 dias.

1. Elegir GitHub Actions o worker dedicado como unico ejecutor.
2. Eliminar el cron de pipeline incompatible de Vercel.
3. Refrescar vistas solo despues de ingesta exitosa.
4. Agregar advisory lock y run ID persistido.
5. Aplicar allowlist de dominios y controles SSRF.
6. Pasar ambientes minimos a subprocesses.
7. Definir timeouts, retries y presupuesto total.
8. Separar descarte, error transitorio y error permanente.
9. Validar respuestas LLM mediante schemas.
10. Cachear Georef.
11. Incorporar concurrencia limitada de medios.
12. Hacer que dry-run garantice cero escrituras.
13. Aplicar realmente `PIPELINE_MAX_NOTICIAS`.

## Fase 6 - Arquitectura y calidad

Duracion estimada: 5 a 10 dias.

1. Dividir `queries.ts` en repositorios.
2. Dividir pipeline en browser, clasificador, geocoder, persistencia y orquestador.
3. Dividir `MapaDelito` en hooks y componentes.
4. Crear tipos y schemas canonicos compartidos.
5. Usar un unico Prisma client.
6. Agregar CI obligatorio para PR.
7. Agregar tests unitarios, integracion y concurrencia.
8. Reescribir README y actualizar documentacion.
9. Fijar npm mediante `packageManager`.
10. Activar gradualmente reglas TypeScript estrictas.
11. Separar roles de base: web read, admin, ingesta, export y migraciones.
12. Migrar Next.js en una rama dedicada y ejecutar pruebas de regresion.

# Orden obligatorio

```text
RCE / Auth / XSS
-> integridad de datos
-> privacidad
-> APIs y concurrencia
-> performance
-> pipeline
-> refactor arquitectonico
```

# Decisiones recomendadas

1. Retirar microdatos SAT publicos y reemplazarlos por agregados H3.
2. Usar GitHub Actions o un worker como unico ejecutor del pipeline.
3. Usar npm como package manager autoritativo.
4. Adoptar schemas runtime para toda frontera externa.
5. No ejecutar refactors grandes antes de corregir integridad de datos.

# Verificaciones por pull request

Cada PR debe incluir, segun corresponda:

- `npm ci`
- Typecheck
- Lint
- Tests unitarios
- Tests de integracion
- Build de Next.js
- `npm audit`
- Comprobacion de migraciones y drift
- Verificacion de que `.env` y secretos no estan trackeados
- Medicion de bundle para cambios frontend
- Dry-run sin escrituras para cambios de pipeline

# Riesgos que requieren decision de negocio

1. Nivel de detalle geografico aceptable para datos publicos.
2. Politica de publicacion de casos preliminares.
3. Definicion formal de verificacion por multiples fuentes.
4. Plataforma definitiva de ejecucion del pipeline.
5. Estrategia de retencion y auditoria de contenido enviado a modelos LLM.
