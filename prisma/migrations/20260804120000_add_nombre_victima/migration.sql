-- Agrega nombre_victima a hechos_delictivos.
--
-- El campo lo extrae el LLM del pipeline (prompt 2 en src/lib/mapa/openrouter.ts)
-- y lo usa el deduplicador para buscar coberturas del mismo caso sin límite
-- temporal, cubriendo noticias que llegan meses después del hecho
-- (proceso judicial, aniversarios, novedades de la investigación).
--
-- Aditivo y nullable: no borra ni modifica ningún dato existente.
-- Idempotente: se puede correr más de una vez sin efecto.
--
-- IMPORTANTE: hasta que esta migración se aplique, el pipeline de medios está
-- caído por completo. schema.prisma declara el campo nombreVictima y los
-- findMany del deduplicador usan `include`, así que Prisma enumera todos los
-- escalares del modelo, incluido nombre_victima. Sin la columna, toda query
-- sobre hechos_delictivos vía Prisma Client falla con P2022 — incluso las
-- noticias sin nombre de víctima.

ALTER TABLE "hechos_delictivos"
  ADD COLUMN IF NOT EXISTS "nombre_victima" TEXT;
