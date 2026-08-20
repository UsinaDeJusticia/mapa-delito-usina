-- ═══════════════════════════════════════════════════════════════════════════
-- Limpiar femicidio en hechos ya revisados como "no es homicidio"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CONTEXTO
-- POST /api/admin/revisiones, cuando la clasificación humana es
-- 'no_es_homicidio', nunca tocaba la columna femicidio ni tipo_delito_id —
-- solo bajaba confianza y limpiaba requiere_revision. Así que un caso que el
-- pipeline marcó "femicidio" (o que alguien clasificó así primero) y que
-- luego una persona corrigió a "no es homicidio" seguía guardado con
-- femicidio='Si'. Esto se corrigió en el código (ver
-- src/app/api/admin/revisiones/route.ts); este script es el backfill de los
-- casos que ya quedaron mal guardados en producción antes del fix.
--
-- ALCANCE DE ESTE SCRIPT — SOLO femicidio, NO tipo_delito_id
-- femicidio es inequívoco: un caso que un humano confirmó "no es homicidio"
-- no puede ser un femicidio (femicidio es un subtipo de homicidio), así que
-- limpiarlo es una corrección segura y sin ambigüedad.
-- tipo_delito_id es harina de otro costal: la columna es NOT NULL y el
-- catálogo SNIC no tiene un código para "no es un hecho delictivo" — dejar
-- esos hechos con el código que tenían antes de la revisión (típicamente 4,
-- "homicidios culposos") es hoy inofensivo porque NINGÚN consumidor cuenta
-- estos casos: quedan excluidos tanto de los pines del mapa público
-- (/api/mapa/hechos-medios filtra por NOT EXISTS clasificacion_humana =
-- 'no_es_homicidio') como de las cifras SAT (mv_sat_provincia y el Parquet
-- filtran por fuentes.tipo = 'OFICIAL', y estos hechos son PERIODISTICA).
-- Corregir tipo_delito_id de fondo requiere una decisión de esquema aparte
-- (agregar un código sentinela al catálogo, o volver la columna nullable) y
-- queda fuera de este script.
--
-- ⚠️ NO CORRER ENTERO DE UNA. Ejecutá el paso 1, mirá el número, y recién
-- entonces decidí si seguís al paso 2.
--
-- Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f este-archivo.sql   ← NO hagas esto
--   Copiá y pegá paso por paso.


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 1 — CONTAR (no modifica nada)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1.a ¿Cuántos hechos están hoy en esta situación, y qué femicidio tienen?
--     La corrección de este script solo importa para las filas con
--     femicidio='Si'; las que ya tienen NULL no cambian con el UPDATE de
--     todos modos (WHERE femicidio = 'Si' las excluye desde el principio,
--     así que este SELECT es solo para tener el número de referencia).
SELECT
  hd.femicidio,
  COUNT(*) AS filas
FROM hechos_delictivos hd
WHERE hd.es_agregado = false
  AND EXISTS (
    SELECT 1 FROM revisiones_pipeline rp
    WHERE rp.hecho_id = hd.id
      AND rp.clasificacion_humana = 'no_es_homicidio'
  )
GROUP BY hd.femicidio;

-- 1.b El detalle de los casos que el paso 2 va a tocar, para revisar a mano
--     si hace falta.
SELECT
  hd.id,
  hd.femicidio,
  hd.tipo_delito_id,
  td.nombre AS tipo_delito_actual,
  hd.confianza,
  rp.revisado_por,
  rp.revisado_at
FROM hechos_delictivos hd
JOIN tipos_delito td ON hd.tipo_delito_id = td.id
JOIN revisiones_pipeline rp ON rp.hecho_id = hd.id
WHERE hd.es_agregado = false
  AND hd.femicidio = 'Si'
  AND rp.clasificacion_humana = 'no_es_homicidio'
ORDER BY rp.revisado_at DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 2 — CORREGIR
-- ═══════════════════════════════════════════════════════════════════════════
-- Limpia femicidio en los hechos donde la revisión humana MÁS RECIENTE es
-- 'no_es_homicidio'. El DISTINCT ON toma la última revisión por hecho: si un
-- caso fue corregido varias veces (femicidio → no_es_homicidio → femicidio de
-- nuevo, por ejemplo), lo que importa es dónde quedó, no el historial.

BEGIN;

WITH ultima_revision AS (
  SELECT DISTINCT ON (hecho_id)
    hecho_id, clasificacion_humana
  FROM revisiones_pipeline
  ORDER BY hecho_id, revisado_at DESC
)
UPDATE hechos_delictivos hd
SET
  femicidio = NULL,
  updated_at = NOW()
FROM ultima_revision ur
WHERE hd.id = ur.hecho_id
  AND hd.es_agregado = false
  AND hd.femicidio = 'Si'
  AND ur.clasificacion_humana = 'no_es_homicidio';

-- Verificá el número que devuelve el UPDATE contra el de 1.a (fila femicidio='Si').
-- Si coincide:      COMMIT;
-- Si no coincide:   ROLLBACK;  y avisá antes de seguir.

-- COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3 — VERIFICAR
-- ═══════════════════════════════════════════════════════════════════════════
-- Debería devolver 0 filas: ya no debería quedar ningún hecho marcado
-- femicidio='Si' cuya última revisión humana sea 'no_es_homicidio'.

WITH ultima_revision AS (
  SELECT DISTINCT ON (hecho_id)
    hecho_id, clasificacion_humana
  FROM revisiones_pipeline
  ORDER BY hecho_id, revisado_at DESC
)
SELECT COUNT(*) AS deberia_ser_cero
FROM hechos_delictivos hd
JOIN ultima_revision ur ON ur.hecho_id = hd.id
WHERE hd.es_agregado = false
  AND hd.femicidio = 'Si'
  AND ur.clasificacion_humana = 'no_es_homicidio';

-- Este UPDATE no cambia ninguna cifra pública hoy (ver "ALCANCE" más arriba:
-- estos hechos ya están excluidos de los pines y de las vistas SAT). No hace
-- falta regenerar Parquet ni refrescar vistas materializadas por este paso.
