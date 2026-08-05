# Pendientes y Features — Mapa del Delito

Registro consolidado del trabajo futuro. Cada ítem indica su fuente en el código o la documentación para no perder contexto. No hay issues abiertos en GitHub; este archivo es la fuente de verdad hasta que existan.

---

## 1. Mejoras de seguridad e infraestructura

Fuente: `docs/security-hardening.md` (sección "Mejoras planificadas").

1. Reemplazar la conexion `neondb_owner` usada en runtime por un rol de minimo privilegio. Reservar el rol de migraciones para GitHub Actions mediante `MIGRATION_DATABASE_URL`.
2. Proteger la rama `master`, exigiendo pull requests y checks exitosos antes del merge.
3. Habilitar secret scanning y push protection en GitHub (repo publico).
4. Configurar limites de gasto, alertas de uso y frecuencia de rotacion para credenciales de base de datos y proveedores LLM.
5. Fijar la version del package manager y usar un unico lockfile autoritativo (npm o pnpm, no ambos) para no eludir controles de supply chain.
6. Auditar y actualizar dependencias reportadas por `npm audit` (15 vulnerabilidades, 2 criticas al 2026-08-05) sin usar actualizaciones forzadas.
7. Serializar la promocion de hechos con coberturas concurrentes y agregar prueba de dos inserciones simultaneas sobre el mismo hecho (race condition detectada en review del PR #10).
8. Hacer que una falla sistemica del proveedor LLM marque la corrida como fallida en lugar de producir un resumen exitoso con contadores en cero (hallazgo del review del PR #10: un 401 del proveedor se reportaba como "0 noticias identificadas").
9. Coordinar migraciones y despliegue para que el codigo nuevo no reciba trafico antes de que el esquema requerido este aplicado.
10. Workflows de GitHub Actions fijados a Node 20 (deprecado): actualizar a Node 24 en `.github/workflows/migraciones.yml` y `pipeline.yml`.

---

## 2. Pendientes del producto

Fuente: `CLAUDE.md`, seccion 11 "Estado actual del producto".

1. ⏳ Refactor visual: distincion mas clara entre capa SNIC y capa de medios en el mapa.
2. ⏳ DuckDB + Parquet + H3 (optimizacion futura, no MVP). Nota: existe una rama `claude/review-duckdb-architecture-zfJFO` con trabajo sobre esto, sin mergear.

---

## 3. Features diferidas (roadmap por fases)

1. **Fase 2 — Filtro por departamento.** Componente `FiltroDepartamento.tsx` escrito pero desactivado en `MapaDelito.tsx` (import y estado comentados). Incluye carga lazy del GeoJSON de departamentos (~1.2MB, `useGeoJSON`). Activar cuando se decida la UX del filtro.
2. **Fase 2 — Filtros SAT detallados en panel publico.** `PanelEstadisticas.tsx` muestra "Filtros detallados (sexo, arma, femicidio) disponibles proximamente". El componente `FiltrosSAT.tsx` ya existe y funciona en la capa de medios; falta habilitarlo para estadisticas del panel.
3. **Fase 3 — Geolocalizacion fina de hechos del pipeline.** `georef.ts` tiene el helper documentado como "Util para el pipeline de medios (Fase 3)": convertir direccion textual de la noticia en coordenadas via Georef, en lugar de ubicar el pin solo en el centroide provincial.

---

## 4. Cobertura de medios del pipeline

Fuente: `docs/medios-auditoria.md` y `scripts/pipeline/scrapear-medios.ts`.

1. **Medios validados:** `rosario3`, `infobae` (scripts dedicados). El array `MEDIOS` hoy tiene ~60 medios activos, muy por encima del objetivo original de 36 del documento de auditoria.
2. **Medios bloqueados por paywall** (`activo: false`): `clarin`, `lanacion`, `lacapitalrosario` (Santa Fe). Se pueden invocar manualmente con `--medio=id` si se consigue acceso.
3. **Documento desactualizado:** `docs/medios-auditoria.md` sigue mostrando 6 medios "pendientes dry-run" que ya estan activos y corriendo (ellitoral, lmneuquen, norte, eltribuno, eldia, lavoz). Actualizar ese documento con el estado real tras la primera corrida completa con OpenCode Go operativo.
4. **Validacion post-migracion LLM:** ejecutar un dry-run por medio sobre los medios nunca testeados desde la migracion a OpenCode Go y registrar resultado (exitoso / 0 noticias / error de red) en el documento de auditoria.

---

## 5. Riesgos conocidos no bloqueantes

Detectados en el review del PR #10 (quedan registrados para no perderlos):

1. Los indices condicionales de `revisiones_pipeline` se saltan silenciosamente si la tabla no existe en un entorno nuevo; recrearla despues no los crea. Considerar migracion aditiva separada o chequeo en setup.
2. `migraciones.yml` no detecta un cambio en `schema.prisma` sin migracion asociada: `migrate deploy` reporta exito con nada pendiente. Considerar `migrate diff` en CI de pull requests.
3. No hay CI de PR que corra type-check, lint ni tests: los checks de PR hoy son solo los de Vercel.

---

## Reglas de mantenimiento de este documento

- Cuando un pendiente se complete, eliminarlo de aqui en el mismo PR que lo resuelve.
- Todo feature nuevo debe anotarse aqui con su fuente y fecha antes de escribir codigo.
- Los items de seguridad tienen prioridad sobre features.
