-- =============================================
-- Materialized Views — Mapa del Delito
-- 
-- Resuelve: 533K filas consultadas al vuelo → ~600 filas pre-calculadas
-- Resultado: de 6 segundos a milisegundos
--
-- Ejecutar en Neon (con ON_ERROR_STOP=1 — ver por qué en hallazgo del PR #15):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/create-materialized-views.sql
--
-- ⚠️ MERGEAR UN CAMBIO A ESTE ARCHIVO NO LO APLICA A PRODUCCIÓN.
-- Estas vistas no son migraciones de Prisma: no hay ningún workflow que las
-- despliegue solas al mergear un PR. `REFRESH MATERIALIZED VIEW` re-ejecuta la
-- definición YA GUARDADA en Neon, no relee este archivo — así que un cambio de
-- WHERE, columnas o joins queda mergeado en el repo y sin efecto en producción
-- hasta que alguien vuelva a correr este archivo entero (el DROP + CREATE de
-- cada vista, no un REFRESH).
--
-- Encontrado en la corrida del runbook post-Fase-1 (agosto 2026):
-- `mv_sat_provincia` en producción seguía con `anio <= 2024` hardcodeado —la
-- definición de antes de este mismo archivo consolidarse en el PR #15— porque
-- nadie la había vuelto a aplicar tras el merge. Excluía en silencio todo dato
-- de 2025 en adelante.
-- =============================================

-- ─── Vista 1: SNIC por provincia + año ──────────────────
-- Usada por: mapa coroplético en modo SNIC (vista por defecto)
-- ~600 filas (24 provincias × 25 años)

DROP MATERIALIZED VIEW IF EXISTS mv_snic_provincia;

CREATE MATERIALIZED VIEW mv_snic_provincia AS
SELECT
  provincia_id,
  provincia AS provincia_nombre,
  anio,
  SUM(cantidad_hechos)::int AS total_hechos,
  SUM(cantidad_victimas)::int AS total_victimas,
  COUNT(DISTINCT tipo_delito_id) AS tipos_delito_count
FROM estadisticas_agregadas
WHERE provincia_id IS NOT NULL
  AND provincia IS NOT NULL
GROUP BY provincia_id, provincia, anio
ORDER BY anio, provincia;

CREATE UNIQUE INDEX idx_mv_snic_prov_anio
  ON mv_snic_provincia (provincia_id, anio);
CREATE INDEX idx_mv_snic_anio
  ON mv_snic_provincia (anio);


-- ─── Vista 2: SNIC por provincia + año + tipo delito ────
-- Usada por: mapa coroplético con filtro de delito
-- ~15K filas (24 prov × 25 años × ~25 delitos promedio)

DROP MATERIALIZED VIEW IF EXISTS mv_snic_provincia_delito;

CREATE MATERIALIZED VIEW mv_snic_provincia_delito AS
SELECT
  ea.provincia_id,
  ea.provincia AS provincia_nombre,
  ea.anio,
  ea.tipo_delito_id,
  td.nombre AS tipo_delito_nombre,
  SUM(ea.cantidad_hechos)::int AS total_hechos,
  SUM(ea.cantidad_victimas)::int AS total_victimas
FROM estadisticas_agregadas ea
JOIN tipos_delito td ON ea.tipo_delito_id = td.id
WHERE ea.provincia_id IS NOT NULL
  AND ea.provincia IS NOT NULL
GROUP BY ea.provincia_id, ea.provincia, ea.anio, ea.tipo_delito_id, td.nombre
ORDER BY ea.anio, ea.provincia;

CREATE UNIQUE INDEX idx_mv_snic_pd_key
  ON mv_snic_provincia_delito (provincia_id, anio, tipo_delito_id);
CREATE INDEX idx_mv_snic_pd_anio
  ON mv_snic_provincia_delito (anio);
CREATE INDEX idx_mv_snic_pd_delito
  ON mv_snic_provincia_delito (tipo_delito_id);


-- ─── Vista 3: SAT por provincia + año ───────────────────
-- Usada por: mapa en modo SAT
-- ~200 filas (24 prov × 8 años)
--
-- ✅ HALLAZGO #10 — RESUELTO (era: "el filtro es_agregado = false no distingue
-- la fuente"). El panel rotula estos totales como "OFICIAL — SAT", pero
-- `es_agregado = false` por sí solo incluía TAMBIÉN los casos PRELIMINARES del
-- pipeline de medios: cifras periodísticas sin confirmar presentadas como dato
-- oficial.
--
-- El comentario anterior decía que la corrección exigía agregar un campo
-- `codigo` a Fuente porque "el modelo solo tiene nombre, que es un string de
-- display". Eso era un error de lectura del esquema: `fuentes.tipo` ya existe y
-- ya es un enum estable (TipoFuente: OFICIAL / PERIODISTICA / CIUDADANA /
-- USINA / ACADEMICA). Las dos ingestas oficiales crean su fuente con
-- tipo='OFICIAL' y el pipeline de medios con tipo='PERIODISTICA', así que
-- alcanza con filtrar por ahí — sin migración ni columna nueva.
--
-- El JOIN es INNER a propósito: hechos_delictivos.fuente_id es NOT NULL, así
-- que no puede descartar filas por sí mismo.
--
-- Consecuencia visible y esperada: los hechos del pipeline salen de este
-- agregado. Siguen viéndose en el mapa como pines individuales, que es su
-- lugar — los sirve /api/mapa/hechos-medios, con su propia leyenda de
-- PRELIMINAR. Lo mismo aplica a la Vista 4.

DROP MATERIALIZED VIEW IF EXISTS mv_sat_provincia;

CREATE MATERIALIZED VIEW mv_sat_provincia AS
SELECT
  u.provincia_id,
  u.provincia AS provincia_nombre,
  hd.anio,
  COUNT(*)::int AS total_hechos,
  SUM(hd.cantidad_victimas)::int AS total_victimas,
  SUM(CASE WHEN hd.femicidio = 'Si' THEN 1 ELSE 0 END)::int AS femicidios
  -- Acá había una columna sexos_distintos con COUNT(DISTINCT hd.victima_sexo).
  -- Esa columna no existe: la real es "victimaSexo" en camelCase, creada
  -- entrecomillada en 20260323085453_add_sat_detail_columns porque el modelo de
  -- Prisma no le puso @map. El CREATE fallaba siempre en esta vista, y como psql
  -- continúa tras un error salvo que se le pase ON_ERROR_STOP=1, el DROP de
  -- arriba sí se ejecutaba y la vista quedaba sin crear. De ahí nacieron los dos
  -- archivos SQL duplicados que este commit elimina.
  -- Ninguna consulta de la app usaba sexos_distintos, así que se quita en lugar
  -- de corregirla.
FROM hechos_delictivos hd
JOIN ubicaciones u ON hd.ubicacion_id = u.id
JOIN fuentes f ON hd.fuente_id = f.id
WHERE hd.es_agregado = false
  AND f.tipo = 'OFICIAL'
  AND hd.anio <= EXTRACT(YEAR FROM CURRENT_DATE)::int
  AND u.provincia IS NOT NULL
GROUP BY u.provincia_id, u.provincia, hd.anio
ORDER BY hd.anio, u.provincia;

CREATE UNIQUE INDEX idx_mv_sat_prov_anio
  ON mv_sat_provincia (provincia_id, anio);
CREATE INDEX idx_mv_sat_anio
  ON mv_sat_provincia (anio);


-- ─── Vista 4: Años disponibles (cache) ──────────────────
-- Evita DISTINCT sobre tablas grandes

DROP MATERIALIZED VIEW IF EXISTS mv_anios_disponibles;

CREATE MATERIALIZED VIEW mv_anios_disponibles AS
SELECT 'snic' AS fuente, anio
FROM (SELECT DISTINCT anio FROM estadisticas_agregadas ORDER BY anio) sub
UNION ALL
SELECT 'sat' AS fuente, anio
FROM (
  -- Mismo filtro por tipo de fuente que la Vista 3, por la misma razón: el
  -- selector de años del modo SAT no debe ofrecer años que solo existen por
  -- datos del pipeline periodístico. Ver el comentario de la Vista 3.
  SELECT DISTINCT hd.anio
  FROM hechos_delictivos hd
  JOIN fuentes f ON hd.fuente_id = f.id
  WHERE hd.es_agregado = false
    AND f.tipo = 'OFICIAL'
    AND hd.anio <= EXTRACT(YEAR FROM CURRENT_DATE)::int
  ORDER BY hd.anio
) sub2;

CREATE INDEX idx_mv_anios_fuente ON mv_anios_disponibles (fuente);


-- ─── Verificación ───────────────────────────────────────

SELECT 'mv_snic_provincia' AS vista, COUNT(*) AS filas FROM mv_snic_provincia
UNION ALL
SELECT 'mv_snic_provincia_delito', COUNT(*) FROM mv_snic_provincia_delito
UNION ALL
SELECT 'mv_sat_provincia', COUNT(*) FROM mv_sat_provincia
UNION ALL
SELECT 'mv_anios_disponibles', COUNT(*) FROM mv_anios_disponibles;