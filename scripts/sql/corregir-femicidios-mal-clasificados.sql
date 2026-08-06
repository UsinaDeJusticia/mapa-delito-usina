-- ═══════════════════════════════════════════════════════════════════════════
-- Corrección de femicidios guardados con la categoría equivocada
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO
-- Hasta este cambio, tanto el pipeline como el panel de revisión asignaban el
-- código SNIC 4 a los femicidios. El código 4 del catálogo oficial es
-- "Homicidios culposos por otros hechos" (negligencia médica, accidentes
-- laborales), así que esos casos quedaron indistinguibles de muertes
-- accidentales, y el mapa público mostraba literalmente ese texto.
--
-- Un femicidio es un homicidio doloso: código 1. La condición de femicidio se
-- guarda aparte, en la columna femicidio.
--
-- ⚠️ NO CORRER ENTERO DE UNA. Está dividido en pasos: los primeros solo
-- CUENTAN y no modifican nada. Ejecutá el paso 1, mirá los números, y recién
-- entonces decidí si seguís.
--
-- ⚠️ LO QUE ESTE SCRIPT NO DEBE TOCAR
-- Las filas con es_agregado = true son datos oficiales del SNIC, donde el
-- código 4 significa correctamente "homicidios culposos por otros hechos".
-- Reclasificarlas sería corromper el dato oficial. Todos los UPDATE filtran
-- por es_agregado = false.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f este-archivo.sql   ← NO hagas esto
--   Copiá y pegá paso por paso.


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 1 — CONTAR (no modifica nada)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1.a ¿Cuántas filas apuntan hoy al código 4, y de qué tipo son?
--     Esto separa el dato oficial legítimo de los casos mal clasificados.
SELECT
  hd.es_agregado,
  f.nombre AS fuente,
  hd.confianza,
  COUNT(*) AS filas
FROM hechos_delictivos hd
JOIN tipos_delito td ON hd.tipo_delito_id = td.id
LEFT JOIN fuentes f ON hd.fuente_id = f.id
WHERE td.codigo_snic = '4'
GROUP BY hd.es_agregado, f.nombre, hd.confianza
ORDER BY hd.es_agregado, filas DESC;

-- 1.b ¿Cuáles fueron marcados como femicidio por una persona del equipo?
--     Estos son los casos con evidencia humana explícita: la corrección es
--     inequívoca.
SELECT COUNT(*) AS revisados_como_femicidio
FROM hechos_delictivos hd
JOIN tipos_delito td ON hd.tipo_delito_id = td.id
WHERE td.codigo_snic = '4'
  AND hd.es_agregado = false
  AND EXISTS (
    SELECT 1 FROM revisiones_pipeline rp
    WHERE rp.hecho_id = hd.id
      AND rp.clasificacion_humana = 'femicidio'
  );

-- 1.c ¿Cuáles llegaron al código 4 solo por clasificación automática, sin
--     revisión humana? Acá no hay certeza de que sean femicidios: el modelo
--     pudo haber querido decir "femicidio" (según el prompt viejo) o
--     genuinamente "culposo". Se tratan aparte en el paso 3.
SELECT COUNT(*) AS solo_automaticos
FROM hechos_delictivos hd
JOIN tipos_delito td ON hd.tipo_delito_id = td.id
WHERE td.codigo_snic = '4'
  AND hd.es_agregado = false
  AND NOT EXISTS (
    SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
  );

-- 1.d Estado actual de la columna femicidio, para tener la línea de base.
SELECT
  COALESCE(femicidio, '(vacío)') AS femicidio,
  es_agregado,
  COUNT(*) AS filas
FROM hechos_delictivos
GROUP BY femicidio, es_agregado
ORDER BY es_agregado, filas DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 2 — CORREGIR los revisados por una persona (recomendado)
-- ═══════════════════════════════════════════════════════════════════════════
-- Estos son los casos donde alguien del equipo apretó "Femicidio" en el panel.
-- Hay evidencia humana explícita, así que la corrección es segura.
--
-- Efecto en el mapa: estos casos pasan de "Homicidios culposos por otros
-- hechos" a "Homicidios dolosos", y quedan marcados como femicidio.

BEGIN;

UPDATE hechos_delictivos hd
SET
  tipo_delito_id = (SELECT id FROM tipos_delito WHERE codigo_snic = '1' LIMIT 1),
  femicidio = 'Si',
  updated_at = NOW()
WHERE hd.es_agregado = false
  AND hd.tipo_delito_id = (SELECT id FROM tipos_delito WHERE codigo_snic = '4' LIMIT 1)
  AND EXISTS (
    SELECT 1 FROM revisiones_pipeline rp
    WHERE rp.hecho_id = hd.id
      AND rp.clasificacion_humana = 'femicidio'
  );

-- Verificá el número que devuelve el UPDATE contra el del paso 1.b.
-- Si coinciden:      COMMIT;
-- Si no coinciden:   ROLLBACK;  y avisá antes de seguir.

-- COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3 — Los automáticos: marcar para revisión, NO reclasificar
-- ═══════════════════════════════════════════════════════════════════════════
-- Acá no hay certeza. El prompt viejo le decía al modelo que el 4 era
-- femicidio, así que probablemente la mayoría lo sean, pero también pudo
-- clasificar correctamente algún culposo real. Reclasificar a ciegas cambiaría
-- cifras públicas sobre víctimas basándose en una suposición.
--
-- En lugar de eso se los manda a la cola de revisión humana del panel, para que
-- el equipo los resuelva caso por caso con la nota periodística a la vista.

BEGIN;

UPDATE hechos_delictivos hd
SET
  requiere_revision = true,
  updated_at = NOW()
WHERE hd.es_agregado = false
  AND hd.tipo_delito_id = (SELECT id FROM tipos_delito WHERE codigo_snic = '4' LIMIT 1)
  AND NOT EXISTS (
    SELECT 1 FROM revisiones_pipeline rp WHERE rp.hecho_id = hd.id
  );

-- Compará con el paso 1.c. Si coincide: COMMIT;
-- COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 4 — Refrescar las vistas y verificar
-- ═══════════════════════════════════════════════════════════════════════════

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_snic_provincia;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_snic_provincia_delito;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sat_provincia;
REFRESH MATERIALIZED VIEW mv_anios_disponibles;

-- Verificación: ya no debería quedar ninguna fila del pipeline en el código 4
-- sin revisión pendiente.
SELECT COUNT(*) AS deberia_ser_cero
FROM hechos_delictivos hd
JOIN tipos_delito td ON hd.tipo_delito_id = td.id
WHERE td.codigo_snic = '4'
  AND hd.es_agregado = false
  AND hd.requiere_revision = false;

-- Y ahora el mapa debería reportar femicidios donde antes había cero.
SELECT provincia_nombre, anio, femicidios
FROM mv_sat_provincia
WHERE femicidios > 0
ORDER BY anio DESC, femicidios DESC
LIMIT 20;


-- ═══════════════════════════════════════════════════════════════════════════
-- DESPUÉS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Regenerar los Parquet, o el mapa público sigue mostrando el snapshot viejo:
--      duckdb < scripts/export/export_parquet.sql
--    y commitear los archivos de public/data/.
-- 2. La página de metodología ya explica la separación de femicidios. Si el
--    cambio de cifras es visible, conviene avisarlo a quienes consultan el mapa
--    con regularidad.
