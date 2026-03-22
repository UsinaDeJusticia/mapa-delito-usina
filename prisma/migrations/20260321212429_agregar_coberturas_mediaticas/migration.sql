-- CreateEnum
CREATE TYPE "TipoCobertura" AS ENUM ('HECHO_INICIAL', 'ACTUALIZACION', 'DETENCION', 'MARCHA_RECLAMO', 'PROCESO_JUDICIAL', 'SENTENCIA', 'ANIVERSARIO', 'OPINION_EDITORIAL');

-- CreateTable
CREATE TABLE "coberturas_mediaticas" (
    "id" TEXT NOT NULL,
    "hecho_delictivo_id" TEXT NOT NULL,
    "medio" TEXT NOT NULL,
    "medio_tipo" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fecha_publicacion" TIMESTAMP(3) NOT NULL,
    "resumen" TEXT,
    "tipo_cobertura" "TipoCobertura" NOT NULL DEFAULT 'HECHO_INICIAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coberturas_mediaticas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coberturas_mediaticas_url_key" ON "coberturas_mediaticas"("url");

-- CreateIndex
CREATE INDEX "coberturas_mediaticas_hecho_delictivo_id_idx" ON "coberturas_mediaticas"("hecho_delictivo_id");

-- CreateIndex
CREATE INDEX "coberturas_mediaticas_medio_idx" ON "coberturas_mediaticas"("medio");

-- CreateIndex
CREATE INDEX "coberturas_mediaticas_fecha_publicacion_idx" ON "coberturas_mediaticas"("fecha_publicacion");

-- AddForeignKey
ALTER TABLE "coberturas_mediaticas" ADD CONSTRAINT "coberturas_mediaticas_hecho_delictivo_id_fkey" FOREIGN KEY ("hecho_delictivo_id") REFERENCES "hechos_delictivos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
