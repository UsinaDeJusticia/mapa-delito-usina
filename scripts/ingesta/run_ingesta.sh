#!/usr/bin/env bash
# =============================================================
# Pipeline de ingesta SNIC + SAT -> Neon
# Mapa del Delito - Usina de Justicia
#
# Prerequisitos:
#   1. export DATABASE_URL="postgresql://..."
#   2. npx prisma migrate dev --name add_sat_detail_columns
#   3. Tabla TipoDelito poblada (seed)
#
# Uso:
#   bash scripts/ingesta/run_ingesta.sh
# =============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Falta DATABASE_URL"
  echo '   export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"'
  exit 1
fi

echo "============================================"
echo "  PASO 0: Verificar archivos CSV"
echo "============================================"
for f in "data/snic/snic-departamentos-anual.csv" "data/snic/SAT-HD-BU_2017-2024.csv"; do
  if [ -f "$f" ]; then
    size=$(du -h "$f" | cut -f1)
    lines=$(wc -l < "$f")
    echo "  OK $f ($size, $lines lineas)"
  else
    echo "  NO ENCONTRADO: $f"
    exit 1
  fi
done

echo ""
echo "============================================"
echo "  PASO 1: Dry Run"
echo "============================================"
echo ""
echo "--- SNIC Departamentos ---"
python "$SCRIPT_DIR/snic-departamentos.py" --dry-run
echo ""
echo "--- SAT Homicidios ---"
python "$SCRIPT_DIR/sat-homicidios.py" --dry-run

echo ""
echo "============================================"
echo "  Todo OK? Continuar con ingesta real? (s/n)"
echo "============================================"
read -r resp
if [ "$resp" != "s" ]; then
  echo "Cancelado."
  exit 0
fi

echo ""
echo "============================================"
echo "  PASO 2: Ingesta real -> Neon"
echo "============================================"
echo ""
echo "--- SNIC Departamentos -> EstadisticaAgregada ---"
python "$SCRIPT_DIR/snic-departamentos.py"
echo ""
echo "--- SAT Homicidios -> HechoDelictivo + Ubicacion ---"
python "$SCRIPT_DIR/sat-homicidios.py"

echo ""
echo "Pipeline completo."