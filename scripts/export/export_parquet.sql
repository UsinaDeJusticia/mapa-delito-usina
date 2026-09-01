-- ============================================================
-- Exportar datos desde Neon como Parquet
--
-- Requisitos:
--   1. DuckDB CLI instalado (brew install duckdb / https://duckdb.org/docs/installation)
--   2. Variable de entorno DATABASE_URL con la URL de Neon
--
-- Uso:
--   DATABASE_URL="postgres://..." npm run export:parquet
--
-- ⚠️ NO correr este archivo directo con `duckdb < …`: no incluye el ATTACH, así
-- que fallaría con "Catalog neon does not exist". El preámbulo de conexión
-- (INSTALL / LOAD / ATTACH) lo agrega scripts/export/export-parquet.ts y se lo
-- pasa a DuckDB por stdin.
--
-- Antes este archivo abría con `ATTACH getenv('DATABASE_URL') AS neon (...)`.
-- Eso NO funciona: el parser de ATTACH exige un literal de string y rechaza
-- cualquier llamada a función. Verificado en DuckDB 1.5.3 — falla igual con
-- getenv() y con getvariable(). No lo "arregles" volviendo a poner el ATTACH
-- acá: la razón por la que vive en el wrapper es que lleva la credencial, y así
-- no queda ni en disco ni en la lista de procesos. Ver el comentario de cabecera
-- de export-parquet.ts.
--
-- Archivos generados en public/data/:
--   snic_provincia.parquet          (~pocos KB)
--   snic_provincia_delito.parquet   (~pocos KB)
--   sat_provincia.parquet           (~pocos KB)
--   anios_disponibles.parquet       (~1 KB)
--   hechos_sat.parquet              (~1-5 MB)
-- ============================================================

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
--
-- Sin hd.id (UUID) a propósito. Este Parquet se sirve como archivo estático
-- público desde Vercel: es microdato fila por fila (sexo, vínculo, femicidio,
-- contexto) de la base SAT. El UUID no aporta nada a las consultas del mapa
-- (ninguna en src/hooks/useMapaData.ts ni useH3Density.ts lo selecciona; todas
-- piden columnas explícitas, nunca SELECT *) y sí facilita cruzar una fila de
-- este archivo público con el registro interno correspondiente en la base. Es
-- el hallazgo #11 del plan de seguridad — las coordenadas ya eran centroides
-- provinciales, no domicilios, pero el resto de la recomendación (agregación
-- a nivel celda, supresión de celdas chicas) queda para más adelante.
COPY (
  SELECT
    hd.anio,
    u.provincia_id,
    u.provincia,
    u.latitud::DOUBLE AS latitud,
    u.longitud::DOUBLE AS longitud,
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
  JOIN neon.public.fuentes f ON hd.fuente_id = f.id
  -- f.tipo = 'OFICIAL': este Parquet alimenta el modo SAT del mapa, que se
  -- presenta como dato oficial. Sin el filtro arrastra los casos PRELIMINARES
  -- del pipeline de medios. Mismo hallazgo #10 que las vistas materializadas;
  -- ver scripts/sql/create-materialized-views.sql (Vista 3).
  -- DuckDB sobre estos Parquet es el camino por defecto del mapa y la API es
  -- solo el respaldo, así que arreglar las vistas sin arreglar esto no se
  -- vería en producción.
  WHERE hd.es_agregado = false
    AND f.tipo = 'OFICIAL'
    AND u.provincia IS NOT NULL
  ORDER BY hd.anio, u.provincia
) TO 'public/data/hechos_sat.parquet'
(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000);

DETACH neon;

SELECT 'Export complete' AS status;
