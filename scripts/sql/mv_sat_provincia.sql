DROP MATERIALIZED VIEW IF EXISTS mv_sat_provincia;

CREATE MATERIALIZED VIEW mv_sat_provincia AS
SELECT
  u.provincia_id,
  u.provincia AS provincia_nombre,
  hd.anio,
  COUNT(*)::int AS total_hechos,
  SUM(hd.cantidad_victimas)::int AS total_victimas,
  SUM(CASE WHEN hd.femicidio = 'Si' THEN 1 ELSE 0 END)::int AS femicidios
FROM hechos_delictivos hd
JOIN ubicaciones u ON hd.ubicacion_id = u.id
WHERE hd.es_agregado = false
  AND hd.anio <= EXTRACT(YEAR FROM CURRENT_DATE)::int
  AND u.provincia IS NOT NULL
GROUP BY u.provincia_id, u.provincia, hd.anio
ORDER BY hd.anio, u.provincia;

CREATE UNIQUE INDEX idx_mv_sat_prov_anio
  ON mv_sat_provincia (provincia_id, anio);
CREATE INDEX idx_mv_sat_anio
  ON mv_sat_provincia (anio);