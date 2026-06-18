-- ============================================================
-- Exportar datos desde Neon como Parquet (via DuckDB CLI)
--
-- Requisitos:
--   1. DuckDB CLI instalado (brew install duckdb / https://duckdb.org/docs/installation)
--   2. Variable de entorno DATABASE_URL con la URL de Neon
--
-- Uso:
--   DATABASE_URL="postgres://..." duckdb < scripts/export/export_parquet.sql
--
-- Archivos generados en public/data/:
--   snic_provincia.parquet          (~pocos KB)
--   snic_provincia_delito.parquet   (~pocos KB)
--   sat_provincia.parquet           (~pocos KB)
--   anios_disponibles.parquet       (~1 KB)
--   hechos_sat.parquet              (~1-5 MB)
-- ============================================================

INSTALL postgres;
LOAD postgres;

-- Conectar a Neon como lector
ATTACH getenv('DATABASE_URL') AS neon (TYPE postgres, READ_ONLY);

-- ─── Vista 1: SNIC por provincia ────────────────────────
COPY (
  SELECT provincia_id, provincia_nombre, anio,
         total_hechos, total_victimas, tipos_delito_count
  FROM neon.public.mv_snic_provincia
  ORDER BY anio, provincia_nombre
) TO 'public/data/snic_provincia.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD);

-- ─── Vista 2: SNIC por provincia + delito ───────────────
COPY (
  SELECT provincia_id, provincia_nombre, anio,
         tipo_delito_id, tipo_delito_nombre,
         total_hechos, total_victimas
  FROM neon.public.mv_snic_provincia_delito
  ORDER BY anio, provincia_nombre
) TO 'public/data/snic_provincia_delito.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD);

-- ─── Vista 3: SAT por provincia ─────────────────────────
COPY (
  SELECT provincia_id, provincia_nombre, anio,
         total_hechos, total_victimas, femicidios
  FROM neon.public.mv_sat_provincia
  ORDER BY anio, provincia_nombre
) TO 'public/data/sat_provincia.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD);

-- ─── Vista 4: Años disponibles ──────────────────────────
COPY (
  SELECT fuente, anio
  FROM neon.public.mv_anios_disponibles
  ORDER BY fuente, anio
) TO 'public/data/anios_disponibles.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD);

-- ─── Hechos SAT individuales (para filtros client-side) ──
COPY (
  SELECT
    hd.id,
    hd.anio,
    u.provincia_id,
    u.provincia,
    hd.cantidad_victimas,
    hd."victimaSexo" AS victima_sexo,
    hd."medioComision" AS medio_comision,
    hd.femicidio,
    hd."vinculoVictimaVictimario" AS vinculo,
    hd."lugarHecho" AS lugar_hecho,
    hd.subtipo,
    hd.contexto
  FROM neon.public.hechos_delictivos hd
  JOIN neon.public.ubicaciones u ON hd.ubicacion_id = u.id
  WHERE hd.es_agregado = false
    AND u.provincia IS NOT NULL
  ORDER BY hd.anio, u.provincia
) TO 'public/data/hechos_sat.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000);

DETACH neon;

SELECT 'Export complete' AS status;
