#!/usr/bin/env bash
#
# Lee las cifras agregadas del modo SAT desde los Parquet LOCALES de
# public/data/ y las emite en formato clave=valor, listo para $GITHUB_OUTPUT.
#
# No toca la base: consulta los archivos. Por eso sirve tanto para leer las
# cifras que están hoy en master (antes del export) como las recién generadas
# (después), y comparar unas contra otras.
#
# Estos son los cuatro números que hacen de rastro de auditoría cuando cambian
# cifras públicas sobre víctimas. La última vez se armaron a mano; acá salen
# solos y quedan en el cuerpo del PR.
#
# Uso:  bash .github/scripts/cifras-parquet.sh >> "$GITHUB_OUTPUT"

set -euo pipefail

SAT_PROVINCIA='public/data/sat_provincia.parquet'
ANIOS='public/data/anios_disponibles.parquet'

for archivo in "$SAT_PROVINCIA" "$ANIOS"; do
  if [ ! -f "$archivo" ]; then
    echo "No existe $archivo — ¿se corrió desde la raíz del repo?" >&2
    exit 1
  fi
done

# -noheader -list: una sola línea con los valores separados por |, sin adornos.
leer() {
  duckdb -noheader -list -c "$1" | tr -d '[:space:]'
}

HECHOS=$(leer      "SELECT COALESCE(SUM(total_hechos), 0)   FROM '$SAT_PROVINCIA'")
VICTIMAS=$(leer    "SELECT COALESCE(SUM(total_victimas), 0) FROM '$SAT_PROVINCIA'")
FEMICIDIOS=$(leer  "SELECT COALESCE(SUM(femicidios), 0)     FROM '$SAT_PROVINCIA'")
ANIOS_SAT=$(leer   "SELECT COUNT(*) FROM '$ANIOS' WHERE fuente = 'sat'")

echo "hechos=$HECHOS"
echo "victimas=$VICTIMAS"
echo "femicidios=$FEMICIDIOS"
echo "anios=$ANIOS_SAT"
