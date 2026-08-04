-- Índices para las queries de /api/admin/revisiones.
--
-- Todas las sentencias son CREATE INDEX IF NOT EXISTS: aditivas, idempotentes
-- y sin pérdida de datos. Ninguna borra ni modifica filas.
--
-- No se usa CONCURRENTLY porque Prisma envuelve cada migración en una
-- transacción y CONCURRENTLY no puede correr dentro de una. Las tablas
-- involucradas son de pocos miles de filas, así que el lock es de milisegundos.

-- ── Tablas gestionadas por Prisma ──
-- SQL generado con `prisma migrate diff` para que los nombres coincidan con
-- los @@index declarados en schema.prisma y no se detecte drift.

-- Cola de pendientes: WHERE confianza = 'PRELIMINAR' ORDER BY hd.created_at DESC.
-- Antes el único índice sobre confianza no cubría el ordenamiento y cada página
-- hacía un sort completo de todos los PRELIMINAR.
CREATE INDEX IF NOT EXISTS "hechos_delictivos_confianza_created_at_idx"
  ON "hechos_delictivos"("confianza", "created_at" DESC);

-- Top-N de coberturas por hecho: el LEFT JOIN LATERAL (LIMIT 1) y el
-- json_agg (LIMIT 12). Con el índice simple sobre hecho_delictivo_id había
-- que ordenar en memoria; ahora sale directo del índice.
CREATE INDEX IF NOT EXISTS "coberturas_mediaticas_hecho_delictivo_id_created_at_idx"
  ON "coberturas_mediaticas"("hecho_delictivo_id", "created_at" DESC);

-- ── revisiones_pipeline (fuera de Prisma) ──
-- Esta tabla la crea scripts/sql/create-revisiones-pipeline.sql, no Prisma.
-- El guard evita que la migración falle en un entorno donde todavía no existe.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'revisiones_pipeline'
  ) THEN

    -- Anti-join del NOT EXISTS que filtra los hechos ya revisados.
    -- El índice existente (idx_revisiones_sin_revisar) es PARCIAL
    -- (WHERE clasificacion_humana IS NULL), así que el planner no puede
    -- usarlo para esa subconsulta y hacía seq scan en cada request.
    CREATE INDEX IF NOT EXISTS "idx_revisiones_pipeline_hecho_id"
      ON revisiones_pipeline(hecho_id);

    -- Ventana de "revisados recientes": WHERE revisado_at >= NOW() - INTERVAL '48 hours'
    -- y el ORDER BY del DISTINCT ON. No tenía ningún índice.
    CREATE INDEX IF NOT EXISTS "idx_revisiones_pipeline_revisado_at"
      ON revisiones_pipeline(revisado_at DESC);

  END IF;
END $$;
