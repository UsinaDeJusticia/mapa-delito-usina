-- =============================================
-- Materialized Views — Mapa del Delito
-- 
-- Resuelve: 533K filas consultadas al vuelo → ~600 filas pre-calculadas
-- Resultado: de 6 segundos a milisegundos
--
-- Ejecutar en Neon:
--   psql $DATABASE_URL -f scripts/sql/create-materialized-views.sql
--
-- O desde OpenCode:
--   export DATABASE_URL="..." && psql $DATABASE_URL -f scripts/sql/create-materialized-views.sql
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

DROP MATERIALIZED VIEW IF EXISTS mv_sat_provincia;

CREATE MATERIALIZED VIEW mv_sat_provincia AS
SELECT
  u.provincia_id,
  u.provincia AS provincia_nombre,
  hd.anio,
  COUNT(*)::int AS total_hechos,
  SUM(hd.cantidad_victimas)::int AS total_victimas,
  SUM(CASE WHEN hd.femicidio = 'Si' THEN 1 ELSE 0 END)::int AS femicidios,
  COUNT(DISTINCT hd.victima_sexo) AS sexos_distintos
FROM hechos_delictivos hd
JOIN ubicaciones u ON hd.ubicacion_id = u.id
WHERE hd.es_agregado = false
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
  SELECT DISTINCT anio FROM hechos_delictivos
  WHERE es_agregado = false
    AND anio <= EXTRACT(YEAR FROM CURRENT_DATE)::int
  ORDER BY anio
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