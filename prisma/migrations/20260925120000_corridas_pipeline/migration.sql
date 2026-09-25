-- Corridas del pipeline de medios: cola, historial y latido del agente local.
--
-- El panel /admin/pipeline encola corridas; el agente local
-- (scripts/pipeline/agente-local.ts) las toma y las ejecuta en la computadora
-- del equipo en lugar de GitHub Actions. Las corridas de Actions y de la línea
-- de comandos se registran en la misma tabla para que el historial sea uno.
-- Ver docs/agente-local.md.
--
-- SQL generado con `prisma migrate diff` (nombres de índices y constraints
-- idénticos a los que espera schema.prisma), con dos ajustes a mano:
-- guardas IF NOT EXISTS para que sea idempotente como el resto de las
-- migraciones posteriores, y la FK declarada dentro del CREATE TABLE para
-- que también quede cubierta por esa guarda. Solo crea: no toca ninguna tabla
-- existente ni borra datos.

CREATE TABLE IF NOT EXISTS "corridas_pipeline" (
    "id" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "origen" TEXT NOT NULL,
    "solicitada_por" TEXT,
    "parametros" JSONB NOT NULL DEFAULT '{}',
    "clave_unica" TEXT,
    "agente" TEXT,
    "progreso" JSONB,
    "resumen" JSONB,
    "error" TEXT,
    "exit_code" INTEGER,
    "cancelacion_solicitada" BOOLEAN NOT NULL DEFAULT false,
    "creada_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciada_at" TIMESTAMP(3),
    "finalizada_at" TIMESTAMP(3),
    "latido_at" TIMESTAMP(3),
    CONSTRAINT "corridas_pipeline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "corridas_pipeline_lineas" (
    "id" SERIAL NOT NULL,
    "corrida_id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "texto" TEXT NOT NULL,
    CONSTRAINT "corridas_pipeline_lineas_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "corridas_pipeline_lineas_corrida_id_fkey" FOREIGN KEY ("corrida_id")
        REFERENCES "corridas_pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "agentes_pipeline" (
    "nombre" TEXT NOT NULL,
    "latido_at" TIMESTAMP(3) NOT NULL,
    "info" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agentes_pipeline_pkey" PRIMARY KEY ("nombre")
);

-- Una sola corrida programada por día aunque haya dos agentes o el respaldo
-- de GitHub Actions compitiendo por hacerla.
CREATE UNIQUE INDEX IF NOT EXISTS "corridas_pipeline_clave_unica_key"
  ON "corridas_pipeline"("clave_unica");

-- El agente busca la corrida pendiente más vieja.
CREATE INDEX IF NOT EXISTS "corridas_pipeline_estado_creada_at_idx"
  ON "corridas_pipeline"("estado", "creada_at");

-- El panel lista el historial de la más nueva a la más vieja.
CREATE INDEX IF NOT EXISTS "corridas_pipeline_creada_at_idx"
  ON "corridas_pipeline"("creada_at" DESC);

-- El panel pide las líneas de log posteriores a la última que ya mostró.
CREATE INDEX IF NOT EXISTS "corridas_pipeline_lineas_corrida_id_id_idx"
  ON "corridas_pipeline_lineas"("corrida_id", "id");
