-- AlterTable
ALTER TABLE "hechos_delictivos" ADD COLUMN     "cantidadImputados" INTEGER,
ADD COLUMN     "contexto" TEXT,
ADD COLUMN     "diaSemana" TEXT,
ADD COLUMN     "femicidio" TEXT,
ADD COLUMN     "hora" TEXT,
ADD COLUMN     "lugarHecho" TEXT,
ADD COLUMN     "medioComision" TEXT,
ADD COLUMN     "medioDetalle" TEXT,
ADD COLUMN     "situacionVictimario" TEXT,
ADD COLUMN     "subtipo" TEXT,
ADD COLUMN     "victimaEdad" INTEGER,
ADD COLUMN     "victimaNacionalidad" TEXT,
ADD COLUMN     "victimaRangoEdad" TEXT,
ADD COLUMN     "victimaSexo" TEXT,
ADD COLUMN     "victimarioEdad" INTEGER,
ADD COLUMN     "victimarioSexo" TEXT,
ADD COLUMN     "vinculoVictimaVictimario" TEXT;

-- AlterTable
ALTER TABLE "ubicaciones" ADD COLUMN     "fuente_ubicacion" TEXT;
