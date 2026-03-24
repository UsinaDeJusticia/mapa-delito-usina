#!/usr/bin/env python3
"""
Ingesta: snic-departamentos-anual.csv -> EstadisticaAgregada (Neon)
Mapa del Delito - Usina de Justicia

Usa relaciones normalizadas: TipoDelito (por codigoSnic) y Fuente.

CSV: 17 cols, separador ;, 533K filas
     1 fila = 1 departamento + 1 anio + 1 tipo de delito

Prerequisitos:
  - Tabla TipoDelito poblada con codigoSnic (seed)
  - Schema migrado con columnas nuevas

Uso:
  DATABASE_URL="postgresql://..." python scripts/ingesta/snic-departamentos.py [--dry-run] [--inspect]
"""

import os
import sys
import csv
import time
import uuid
from collections import defaultdict
import psycopg2
from psycopg2.extras import execute_values

CSV_PATH = "data/snic/snic-departamentos-anual.csv"
SEPARATOR = ";"
BATCH_SIZE = 1000
FUENTE_NOMBRE = "SNIC - Departamentos"

DATABASE_URL = os.environ.get("DATABASE_URL")

_cache_tipo_delito = {}
_cache_fuente_id = None
_codigos_sin_match = set()


def inspect_csv():
    print(f"\n Inspeccionando: {CSV_PATH}")
    with open(CSV_PATH, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f, delimiter=SEPARATOR)
        headers = next(reader)
        print(f"\n {len(headers)} columnas:")
        for i, h in enumerate(headers):
            print(f"  [{i:2d}] {h}")

        print("\n Primeras 5 filas:")
        for row_num, row in enumerate(reader):
            if row_num >= 5:
                break
            print(f"\n  === Fila {row_num + 1} ===")
            for h, v in zip(headers, row):
                print(f"    {h}: {v}")

    with open(CSV_PATH, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=SEPARATOR)
        anios, provs, deptos, delitos = set(), set(), set(), set()
        total = 0
        for row in reader:
            total += 1
            anios.add(row.get("anio", ""))
            provs.add(row.get("provincia_nombre", ""))
            deptos.add(row.get("departamento_id", ""))
            delitos.add(row.get("codigo_delito_snic_nombre", "")[:60])

    print(f"\n Total filas: {total:,}")
    print(f" Anios: {sorted(anios)}")
    print(f" Provincias: {len(provs)}")
    print(f" Departamentos unicos: {len(deptos)}")
    print(f" Tipos de delito unicos: {len(delitos)}")
    print(f"   Ejemplos: {list(delitos)[:8]}")


def pad_depto_id(raw_id):
    cleaned = raw_id.strip()
    if cleaned and cleaned.isdigit():
        return cleaned.zfill(5)
    return cleaned


def safe_int(val):
    val = val.strip()
    if not val or val in ("-", "...", "s/d", "S/D", "///"):
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def obtener_fuente_id(cur):
    global _cache_fuente_id
    if _cache_fuente_id:
        return _cache_fuente_id

    cur.execute('SELECT id FROM fuentes WHERE nombre = %s', (FUENTE_NOMBRE,))
    row = cur.fetchone()

    if row:
        _cache_fuente_id = row[0]
        print(f"  Fuente encontrada: {FUENTE_NOMBRE} (id: {_cache_fuente_id})")
    else:
        _cache_fuente_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO fuentes (id, nombre, tipo, confianza_default, created_at, updated_at, activa) VALUES (%s, %s, %s, %s, NOW(), NOW(), true)',
            (_cache_fuente_id, FUENTE_NOMBRE, "OFICIAL", "OFICIAL")
        )
        print(f"  Fuente creada: {FUENTE_NOMBRE} (id: {_cache_fuente_id})")

    return _cache_fuente_id


def cargar_todos_tipos_delito(cur):
    cur.execute('SELECT id, codigo_snic FROM tipos_delito')
    rows = cur.fetchall()
    for row in rows:
        if row[1] is not None:
            _cache_tipo_delito[row[1]] = row[0]
    print(f"  TipoDelito cargados en cache: {len(_cache_tipo_delito)}")


def obtener_tipo_delito_id(codigo_snic):
    if codigo_snic in _codigos_sin_match:
        return None
    if codigo_snic in _cache_tipo_delito:
        return _cache_tipo_delito[codigo_snic]
    _codigos_sin_match.add(codigo_snic)
    return None


def ingest(dry_run=False):
    if not DATABASE_URL and not dry_run:
        print("Falta DATABASE_URL")
        print('   export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"')
        sys.exit(1)

    print(f"\n{'DRY RUN' if dry_run else 'INGESTA'}: {CSV_PATH} -> EstadisticaAgregada")

    rows = []
    skipped = 0
    with open(CSV_PATH, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=SEPARATOR)
        print(f"Headers: {reader.fieldnames}")

        for raw in reader:
            anio = safe_int(raw.get("anio", ""))
            depto_id = pad_depto_id(raw.get("departamento_id", ""))
            codigo_snic = raw.get("codigo_delito_snic_id", "").strip()

            if not anio or not depto_id or not codigo_snic:
                skipped += 1
                continue

            rows.append({
                "provincia_id": raw.get("provincia_id", "").strip(),
                "provincia_nombre": raw.get("provincia_nombre", "").strip(),
                "departamento_id": depto_id,
                "departamento_nombre": raw.get("departamento_nombre", "").strip(),
                "anio": anio,
                "codigo_snic": codigo_snic,
                "codigo_delito_nombre": raw.get("codigo_delito_snic_nombre", "").strip(),
                "cantidad_hechos": safe_int(raw.get("cantidad_hechos", "")),
                "cantidad_victimas": safe_int(raw.get("cantidad_victimas", "")),
            })

    print(f"\nParseadas: {len(rows):,} filas | Skipped: {skipped}")

    if rows:
        anios = sorted(set(r["anio"] for r in rows))
        deptos = len(set(r["departamento_id"] for r in rows))
        codigos = sorted(set(r["codigo_snic"] for r in rows))
        total_hechos = sum(r["cantidad_hechos"] or 0 for r in rows)

        print(f"Anios: {anios}")
        print(f"Departamentos: {deptos}")
        print(f"Codigos SNIC unicos: {len(codigos)} -> {codigos[:10]}...")
        print(f"Total hechos sumados: {total_hechos:,}")

    if dry_run:
        print("\nDry run completo. No se escribio nada en la BD.")
        return

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    fuente_id = obtener_fuente_id(cur)
    conn.commit()
    cargar_todos_tipos_delito(cur)

    start = time.time()
    sin_tipo = 0

    # Pre-filtrar: resolver TipoDelito y armar tuples
    print("  Resolviendo TipoDelito para cada fila...")
    tuples = []
    for row in rows:
        tipo_delito_id = obtener_tipo_delito_id(row["codigo_snic"])
        if not tipo_delito_id:
            sin_tipo += 1
            continue

        record_id = f"snic-{row['departamento_id']}-{row['anio']}-{row['codigo_snic']}"
        tuples.append((
            record_id, tipo_delito_id,
            row["provincia_id"], row["provincia_nombre"],
            row["departamento_id"], row["departamento_nombre"],
            row["anio"], row["cantidad_hechos"], row["cantidad_victimas"],
        ))

    print(f"  {len(tuples):,} filas listas para insertar | Sin TipoDelito: {sin_tipo:,}")

    # Batch insert con execute_values (mucho mas rapido que INSERT individual)
    SQL = '''
        INSERT INTO estadisticas_agregadas (
            id, tipo_delito_id,
            provincia_id, provincia,
            departamento_id, departamento,
            anio, cantidad_hechos, cantidad_victimas
        ) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            cantidad_hechos = EXCLUDED.cantidad_hechos,
            cantidad_victimas = EXCLUDED.cantidad_victimas
    '''

    PAGE_SIZE = 2000
    inserted = 0
    for i in range(0, len(tuples), PAGE_SIZE):
        batch = tuples[i : i + PAGE_SIZE]
        try:
            execute_values(cur, SQL, batch, page_size=PAGE_SIZE)
            conn.commit()
            inserted += len(batch)
        except Exception as e:
            print(f"  Error en batch {i}: {e}")
            conn.rollback()

        elapsed = time.time() - start
        rate = inserted / elapsed if elapsed > 0 else 0
        print(f"  {inserted:,}/{len(tuples):,} ({elapsed:.1f}s, {rate:.0f} rows/s)")

    cur.close()
    conn.close()
    elapsed = time.time() - start

    print(f"\nIngesta completa en {elapsed:.1f}s")
    print(f"   Insertados/actualizados: {inserted:,}")
    if sin_tipo:
        print(f"   Sin TipoDelito match: {sin_tipo:,}")
        print(f"   Codigos SNIC sin match: {sorted(_codigos_sin_match)}")


if __name__ == "__main__":
    if "--inspect" in sys.argv:
        inspect_csv()
    elif "--dry-run" in sys.argv:
        ingest(dry_run=True)
    else:
        ingest()