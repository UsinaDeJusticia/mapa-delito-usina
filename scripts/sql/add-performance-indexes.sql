-- ============================================================
-- Índices de performance para hechos_delictivos
-- Ejecutar en Neon manualmente. CONCURRENTLY no bloquea escrituras.
-- ============================================================

-- Índices parciales para columnas SAT (solo filas no-agregadas)
-- Usados por /api/mapa/sat-opciones (5 GROUP BY queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_victima_sexo
  ON hechos_delictivos("victimaSexo") WHERE es_agregado = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_medio_comision
  ON hechos_delictivos("medioComision") WHERE es_agregado = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_femicidio
  ON hechos_delictivos(femicidio) WHERE es_agregado = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_vinculo
  ON hechos_delictivos("vinculoVictimaVictimario") WHERE es_agregado = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_lugar
  ON hechos_delictivos("lugarHecho") WHERE es_agregado = false;

-- Índice para hechos-medios (ventana 90 días)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_fecha_hecho
  ON hechos_delictivos(fecha_hecho DESC) WHERE es_agregado = false;

-- Índice para pipeline de revisiones
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hechos_confianza_agregado
  ON hechos_delictivos(confianza, es_agregado) WHERE es_agregado = false;
