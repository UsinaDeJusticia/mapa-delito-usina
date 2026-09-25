# Pendientes y Features — Mapa del Delito

Registro consolidado del trabajo futuro. Cada ítem indica su fuente en el código o la documentación para no perder contexto. No hay issues abiertos en GitHub; este archivo es la fuente de verdad hasta que existan.

La auditoría del 25/09/2026 ([`analisis-2026-09.md`](analisis-2026-09.md)) tiene la evidencia de cada ítem marcado con **§** (sección de ese documento). Prioridad: **P0** privacidad o datos incorrectos publicados, **P1** errores con impacto, **P2** experiencia y rendimiento.

---

## 0. Puesta en marcha tras la auditoría (hacer primero)

Fuente: `analisis-2026-09.md` §3.

1. Instalar el agente local en la computadora del equipo (`docs/agente-local.md`) y lanzar desde `/admin/pipeline` una corrida en modo prueba: es la primera prueba real contra OpenCode Go y los sitios de los medios.
2. Cargar `OPENROUTER_API_KEY` en el `.env` del agente y como secret de Actions (respaldo automático si OpenCode Go rechaza; Go está pensado para agentes de programación y podría bloquear este tráfico).
3. Medir `PIPELINE_LLM_RAZONAMIENTO=bajo` contra el default y dejarlo fijo si mantiene la calidad (deepseek-v4-flash razona en "alto": hasta 6 minutos por identificación).
4. Corrida enfocada con 25 notas por medio para recuperar lo que siga publicado de las dos semanas sin scraping (7 al 24/9).

---

## 1. Mejoras de seguridad e infraestructura

Fuente: `docs/security-hardening.md` (sección "Mejoras planificadas") y `analisis-2026-09.md` §4.5.

1. Reemplazar la conexion `neondb_owner` usada en runtime por un rol de minimo privilegio. Reservar el rol de migraciones para GitHub Actions mediante `MIGRATION_DATABASE_URL`.
2. Proteger la rama `master`, exigiendo pull requests y checks exitosos antes del merge.
3. Habilitar secret scanning y push protection en GitHub (repo publico).
4. Configurar limites de gasto, alertas de uso y frecuencia de rotacion para credenciales de base de datos y proveedores LLM.
5. Fijar la version del package manager (`packageManager` en package.json) para no eludir controles de supply chain.
6. Auditar y actualizar dependencias reportadas por `npm audit` (6 vulnerabilidades, 4 altas, en la corrida del 24/09/2026) sin usar actualizaciones forzadas.
7. Serializar la promocion de hechos con coberturas concurrentes y agregar prueba de dos inserciones simultaneas sobre el mismo hecho (race condition detectada en review del PR #10). Hoy la mitiga que el agente corre una corrida por vez y que el workflow tiene `concurrency`.
8. Coordinar migraciones y despliegue para que el codigo nuevo no reciba trafico antes de que el esquema requerido este aplicado.
9. Actualizar `actions/checkout` y `actions/setup-node` a versiones que corran en Node 24 (las v4 apuntan a Node 20 y Actions ya avisa que lo fuerza).
10. **P1** — Validación runtime de `POST /api/admin/revisiones`: lista blanca de clasificaciones, `AND es_agregado = false` en el UPDATE (hoy un request armado puede tocar un microdato del SAT) y largo máximo de `notas`. §4.5
11. **P2** — Borrar `/api/pipeline/run` y `src/lib/mapa/pipeline-runner.ts`: nadie los llama, Vercel no puede correr el pipeline y el agente local los reemplaza. §4.5
12. **P2** — `auditar-csp.yml`, `probar-feeds.yml` y `verificar-medios.yml` usan `| tee` sin pipefail: el paso da verde aunque el script falle. Usar `shell: bash`. La CI de PR no corre `npm run lint`. §4.5

---

## 2. Datos publicados y privacidad

Fuente: `analisis-2026-09.md` §4.1.

1. **P0** — Regenerar `public/data/hechos_sat.parquet` (todavía tiene la columna `id`, el arreglo de 7c3970a nunca llegó al archivo) y decidir la precisión de sus coordenadas: 8.704 de 16.734 filas tienen una coordenada única junto a sexo, arma, vínculo y contexto. Agregar un test sobre el Parquet commiteado.
2. **P0** — Corregir `PROVINCIAS_CENTROIDES` en `scripts/ingesta/sat-homicidios.py` (Buenos Aires cae en La Pampa, Tucumán en Misiones, Santa Fe en La Rioja, entre otras) y reingerir.
3. **P0 (decisión)** — El aviso de femicidios del modo SAT (`PanelEstadisticas.tsx`, `/metodologia`) dice que no están incluidos en el total, pero `mv_sat_provincia` los cuenta. Definir el criterio y alinear vista, Parquet, panel y metodología.
4. **P1 (decisión)** — Qué casos del pipeline se publican antes de la revisión humana: hoy se muestran los `requiere_revision` y los códigos 2, 3 y 4, sin advertencia de "no revisado" en el mapa.
5. **P1** — Limpiar las ubicaciones con `es_centroide = true` que creó el pipeline antes del 25/09 (ensucian `/api/mapa/provincias`). La consulta para identificarlas está en §4.1.

---

## 3. Pipeline de medios

Fuente: `analisis-2026-09.md` §4.2.

1. **P1** — Notas de juicios, detenciones o aniversarios crean hechos con la fecha de hoy: leer `article:published_time` y no crear hecho nuevo si la fecha es nula o muy anterior a la publicación.
2. **P1** — Búsqueda de candidatos del deduplicador: comparación de provincia sensible a tildes, código SNIC exacto (0/1/2 deberían agruparse) y el `ILIKE` por nombre que reemplaza a la búsqueda por fechas.
3. **P1** — Descartar hechos fuera de Argentina (agregar `pais` al prompt) y no usar la provincia del medio como respaldo sin marcar revisión.
4. **P2** — Normalizar URLs (`?utm=`, `#`, AMP) antes del chequeo de duplicado y del insert.
5. **P2** — `medioUtilizado` y `direccion` nunca se llenan; `tipoCobertura` no aporta.
6. **P2** — Few-shot con el JSON completo y mezcla de positivos y negativos; acción "Duplicado" separada de "No es homicidio" (hoy el manual manda las repetidas ahí y contaminan los ejemplos).
7. **P2** — Georef por `/localidades` antes que `/departamentos`.
8. **P2** — Mandar al LLM solo las líneas `- link` del snapshot.

---

## 4. Panel admin

Fuente: `analisis-2026-09.md` §4.3.

1. **P1** — El polling de `/admin/revisiones` borra lo cargado con "Cargar más" y el OFFSET saltea casos: paginar por cursor y fusionar.
2. **P1** — Los errores (500, sesión vencida, red) se muestran como "No hay casos pendientes". Mismo problema en Feedback.
3. **P1** — Dos revisores sobre el mismo caso: el segundo pisa al primero sin aviso. Responder 409.
4. **P1** — La tarjeta no muestra la sugerencia de femicidio del modelo y clasificar otra cosa la borra.
5. **P2** — "Revisados recientes" ordenado por UUID; "Precisión IA" que puede superar 100 % (guardar la predicción en `clasificacion_llm`); página de error de login en inglés; estrella de "ejemplo" desincronizada.

---

## 5. Mapa público

Fuente: `analisis-2026-09.md` §4.4 y `CLAUDE.md` §11.

1. **P1** — Ante un error de carga se muestran cifras de otro año sin aviso (`useMapaData`, banner de error que nunca aparece).
2. **P1** — El panel de provincia no se actualiza al cambiar año, delito o filtros.
3. **P1** — Año fuera de rango al pasar de SNIC a SAT.
4. **P1** — DuckDB-WASM bloquea la primera vista y lee un Parquet que no existe (`snic_provincia_delito.parquet`): pedir primero la API y cargar DuckDB solo para H3.
5. **P2** — Escala absoluta (tasas cada 100 mil habitantes), leyenda sin cortes numéricos, burbujas superpuestas.
6. **P2** — Mobile: `h-dvh`, input de 16 px, áreas táctiles de 44 px, contraste, ubicación solo a pedido.
7. **P2** — `/dashboard` pública y rota; botón "Revisar" visible para el público; Quilmes resaltado sin explicación.
8. **P2** — Recharts en el paquete inicial, 500 pins sin agrupar, slider sin debounce, fuente Geist sin usar.
9. ⏳ Refactor visual: distincion mas clara entre capa SNIC y capa de medios en el mapa.
10. ⏳ DuckDB + Parquet + H3 (optimizacion futura, no MVP). Existe una rama `claude/review-duckdb-architecture-zfJFO` sin mergear.

---

## 6. Features diferidas (roadmap por fases)

1. **Fase 2 — Filtro por departamento.** Componente `FiltroDepartamento.tsx` escrito pero desactivado en `MapaDelito.tsx` (import y estado comentados). Incluye carga lazy del GeoJSON de departamentos (~1.2MB, `useGeoJSON`). Activar cuando se decida la UX del filtro.
2. **Fase 2 — Filtros SAT detallados en panel publico.** `PanelEstadisticas.tsx` muestra "Filtros detallados (sexo, arma, femicidio) disponibles proximamente". El componente `FiltrosSAT.tsx` ya existe y funciona en la capa de medios; falta habilitarlo para estadisticas del panel.
3. **Fase 3 — Geolocalizacion fina de hechos del pipeline.** `georef.ts` tiene el helper documentado como "Util para el pipeline de medios (Fase 3)": convertir direccion textual de la noticia en coordenadas via Georef, en lugar de ubicar el pin solo en el centroide provincial.
4. **Propuesta (decisión) — Descubrimiento por búsqueda para las zonas en foco.** Además de las portadas de los medios configurados, buscar "homicidio + localidad" en un agregador de noticias desde el panel. Cubriría medios fuera de la lista y notas viejas, pero cambia la política de fuentes. `analisis-2026-09.md` §5.
5. **Descubrimiento por feeds RSS/sitemap** (plan de agosto, Etapa 4; probe en `scripts/pipeline/probar-feeds.ts`).
6. **UX de revisión**: deshacer, atajos de teclado, filtros por provincia/medio/fecha, contador de pendientes en la navegación. **UX pública**: vista compartible por URL, explicación de cada fuente, "actualizado al…". `analisis-2026-09.md` §5.

---

## 7. Cobertura de medios del pipeline

Fuente: `docs/medios-auditoria.md` y `scripts/pipeline/medios-config.ts`.

1. **Medios activos:** 13, uno fuerte por región (recorte de la rama `estable-premio`). El resto está en `activo: false`; desde el panel se pueden sumar a una corrida enfocada con "Incluir medios no verificados".
2. **Medios bloqueados por paywall** (`activo: false`): `clarin`, `lanacion`, `lacapitalrosario` (Santa Fe). Se pueden invocar manualmente con `--medio=id` si se consigue acceso.
3. **Documento desactualizado:** `docs/medios-auditoria.md` sigue mostrando medios "pendientes dry-run" que ya se activaron o se reemplazaron. Actualizarlo con el estado real tras la primera corrida del agente local.
4. **Validacion post-migracion LLM:** ejecutar un dry-run por medio sobre los medios nunca testeados desde la migracion a OpenCode Go y registrar resultado (exitoso / 0 noticias / error de red) en el documento de auditoria. El panel lo permite con una corrida enfocada en modo prueba.

---

## 8. Riesgos conocidos no bloqueantes

Detectados en el review del PR #10 (quedan registrados para no perderlos):

1. Los indices condicionales de `revisiones_pipeline` se saltan silenciosamente si la tabla no existe en un entorno nuevo; recrearla despues no los crea. Considerar migracion aditiva separada o chequeo en setup.
2. `migraciones.yml` no detecta un cambio en `schema.prisma` sin migracion asociada: `migrate deploy` reporta exito con nada pendiente. Considerar `migrate diff` en CI de pull requests.

---

## Reglas de mantenimiento de este documento

- Cuando un pendiente se complete, eliminarlo de aqui en el mismo PR que lo resuelve.
- Todo feature nuevo debe anotarse aqui con su fuente y fecha antes de escribir codigo.
- Los items de seguridad tienen prioridad sobre features.
