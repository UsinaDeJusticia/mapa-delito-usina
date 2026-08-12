-- Agrega requiere_revision a hechos_delictivos.
--
-- La columna está declarada en prisma/schema.prisma desde el commit 7ad61db,
-- pero ninguna migración la creaba: se aplicó a mano contra Neon. En producción
-- funciona y por eso el faltante no se notaba.
--
-- Dónde sí se nota: sobre una base nueva migrada solo con `prisma migrate deploy`
-- el pipeline no arranca. buscarHechosSimilares() en src/lib/mapa/deduplicador.ts
-- usa findMany con `include`, y Prisma entonces selecciona todos los escalares
-- del modelo, incluida esta columna. Sin ella la consulta falla con P2022 en la
-- primera noticia, y como no hay try/catch en ese camino el error llega a
-- main().catch() y termina el proceso con exit 1.
--
-- Aditivo, con default y idempotente: no-op donde ya existe, efectivo en
-- cualquier base nueva. No modifica ninguna fila existente más allá de aplicar
-- el default a las que no tenían la columna.

ALTER TABLE "hechos_delictivos"
  ADD COLUMN IF NOT EXISTS "requiere_revision" BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: la cola de revisión del panel admin filtra por este flag, y
-- solo interesan las filas en true, que son una minoría. Un índice parcial
-- ocupa una fracción del tamaño de uno completo.
CREATE INDEX IF NOT EXISTS "idx_hechos_requiere_revision"
  ON "hechos_delictivos" ("requiere_revision")
  WHERE "requiere_revision" = true;
