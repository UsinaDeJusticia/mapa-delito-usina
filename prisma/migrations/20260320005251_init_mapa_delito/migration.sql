-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "TipoFuente" AS ENUM ('OFICIAL', 'PERIODISTICA', 'CIUDADANA', 'USINA', 'ACADEMICA');

-- CreateEnum
CREATE TYPE "NivelConfianza" AS ENUM ('OFICIAL', 'VERIFICADO', 'PRELIMINAR');

-- CreateEnum
CREATE TYPE "CategoriaDelito" AS ENUM ('CONTRA_PERSONAS', 'CONTRA_PROPIEDAD', 'CONTRA_INTEGRIDAD_SEXUAL', 'CONTRA_LIBERTAD', 'OTROS', 'VIAL');

-- CreateEnum
CREATE TYPE "FranjaHoraria" AS ENUM ('MADRUGADA', 'MANANA', 'TARDE', 'NOCHE');

-- CreateTable
CREATE TABLE "fuentes" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo" "TipoFuente" NOT NULL,
    "url_base" TEXT,
    "frecuencia" TEXT,
    "confianza_default" "NivelConfianza" NOT NULL DEFAULT 'OFICIAL',
    "ultima_actualizacion" TIMESTAMP(3),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuentes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_delito" (
    "id" TEXT NOT NULL,
    "codigo_snic" INTEGER NOT NULL,
    "nombre" TEXT NOT NULL,
    "categoria" "CategoriaDelito" NOT NULL,
    "descripcion" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tipos_delito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_tipos_delito" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "tipo_delito_id" TEXT NOT NULL,

    CONSTRAINT "sub_tipos_delito_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ubicaciones" (
    "id" TEXT NOT NULL,
    "provincia" TEXT NOT NULL,
    "provincia_id" TEXT,
    "departamento" TEXT,
    "departamento_id" TEXT,
    "localidad" TEXT,
    "direccion" TEXT,
    "latitud" DECIMAL(10,7) NOT NULL,
    "longitud" DECIMAL(10,7) NOT NULL,
    "es_centroide" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ubicaciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hechos_delictivos" (
    "id" TEXT NOT NULL,
    "tipo_delito_id" TEXT NOT NULL,
    "fecha_hecho" DATE NOT NULL,
    "hora_hecho" TIME,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER,
    "ubicacion_id" TEXT NOT NULL,
    "cantidad_victimas" INTEGER NOT NULL DEFAULT 1,
    "cantidad_hechos" INTEGER NOT NULL DEFAULT 1,
    "medio_utilizado" TEXT,
    "franja_horaria" "FranjaHoraria",
    "fuente_id" TEXT NOT NULL,
    "confianza" "NivelConfianza" NOT NULL DEFAULT 'OFICIAL',
    "url_fuente" TEXT,
    "es_agregado" BOOLEAN NOT NULL DEFAULT false,
    "es_caso_usina" BOOLEAN NOT NULL DEFAULT false,
    "caso_usina_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hechos_delictivos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casos_usina" (
    "id" TEXT NOT NULL,
    "nombre_familia" TEXT NOT NULL,
    "descripcion" TEXT,
    "estado_judicial" TEXT,
    "fecha_inicio" DATE,
    "consentimiento" BOOLEAN NOT NULL DEFAULT false,
    "url_caso_usina" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casos_usina_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estadisticas_agregadas" (
    "id" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "provincia_id" TEXT,
    "provincia" TEXT,
    "departamento_id" TEXT,
    "departamento" TEXT,
    "tipo_delito_id" TEXT,
    "cantidad_hechos" INTEGER NOT NULL,
    "cantidad_victimas" INTEGER,
    "tasa_por_100k" DECIMAL(8,2),
    "poblacion" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estadisticas_agregadas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fuentes_nombre_key" ON "fuentes"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "tipos_delito_codigo_snic_key" ON "tipos_delito"("codigo_snic");

-- CreateIndex
CREATE INDEX "ubicaciones_provincia_id_idx" ON "ubicaciones"("provincia_id");

-- CreateIndex
CREATE INDEX "ubicaciones_departamento_id_idx" ON "ubicaciones"("departamento_id");

-- CreateIndex
CREATE INDEX "ubicaciones_latitud_longitud_idx" ON "ubicaciones"("latitud", "longitud");

-- CreateIndex
CREATE INDEX "hechos_delictivos_anio_idx" ON "hechos_delictivos"("anio");

-- CreateIndex
CREATE INDEX "hechos_delictivos_tipo_delito_id_idx" ON "hechos_delictivos"("tipo_delito_id");

-- CreateIndex
CREATE INDEX "hechos_delictivos_ubicacion_id_idx" ON "hechos_delictivos"("ubicacion_id");

-- CreateIndex
CREATE INDEX "hechos_delictivos_fuente_id_idx" ON "hechos_delictivos"("fuente_id");

-- CreateIndex
CREATE INDEX "hechos_delictivos_anio_tipo_delito_id_idx" ON "hechos_delictivos"("anio", "tipo_delito_id");

-- CreateIndex
CREATE INDEX "hechos_delictivos_confianza_idx" ON "hechos_delictivos"("confianza");

-- CreateIndex
CREATE INDEX "hechos_delictivos_es_caso_usina_idx" ON "hechos_delictivos"("es_caso_usina");

-- CreateIndex
CREATE INDEX "estadisticas_agregadas_anio_idx" ON "estadisticas_agregadas"("anio");

-- CreateIndex
CREATE INDEX "estadisticas_agregadas_provincia_id_idx" ON "estadisticas_agregadas"("provincia_id");

-- CreateIndex
CREATE INDEX "estadisticas_agregadas_anio_provincia_id_idx" ON "estadisticas_agregadas"("anio", "provincia_id");

-- CreateIndex
CREATE UNIQUE INDEX "estadisticas_agregadas_anio_provincia_id_departamento_id_ti_key" ON "estadisticas_agregadas"("anio", "provincia_id", "departamento_id", "tipo_delito_id");

-- AddForeignKey
ALTER TABLE "sub_tipos_delito" ADD CONSTRAINT "sub_tipos_delito_tipo_delito_id_fkey" FOREIGN KEY ("tipo_delito_id") REFERENCES "tipos_delito"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hechos_delictivos" ADD CONSTRAINT "hechos_delictivos_tipo_delito_id_fkey" FOREIGN KEY ("tipo_delito_id") REFERENCES "tipos_delito"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hechos_delictivos" ADD CONSTRAINT "hechos_delictivos_ubicacion_id_fkey" FOREIGN KEY ("ubicacion_id") REFERENCES "ubicaciones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hechos_delictivos" ADD CONSTRAINT "hechos_delictivos_fuente_id_fkey" FOREIGN KEY ("fuente_id") REFERENCES "fuentes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hechos_delictivos" ADD CONSTRAINT "hechos_delictivos_caso_usina_id_fkey" FOREIGN KEY ("caso_usina_id") REFERENCES "casos_usina"("id") ON DELETE SET NULL ON UPDATE CASCADE;
