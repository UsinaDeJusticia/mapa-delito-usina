#!/usr/bin/env python3
"""
Ingesta: SAT-HD-BU_2017-2024.csv -> HechoDelictivo + Ubicacion (Neon)
Mapa del Delito - Usina de Justicia

Usa relaciones normalizadas: TipoDelito (homicidio doloso) y Fuente.
Columnas de detalle SAT en camelCase para Prisma.

Headers EXACTOS del CSV (46 columnas, separador ;):
  id_hecho, tipo_persona_id, tipo_persona, cant_inc, cant_vic, federal,
  provincia_id, provincia_nombre, departamento_id, departamento_nombre,
  localidad_id, localidad_nombre, radio_censal, latitud_radio, longitud_radio,
  anio, mes, fecha_hecho, hora_hecho, tipo_lugar, tipo_lugar_otro,
  tipo_lugar_ampliado, clase_arma, clase_arma_otro, en_ocasion_otro_delito,
  en_ocasion_otro_delito_otro, motivo_origen_registro, motivo_origen_registro_otro,
  victima_sexo, victima_identidad_genero, victima_identidad_genero_otro,
  victima_tr_edad, victima_18_anios_o_mas, victima_clase, victima_clase_otro,
  victima_situacion_ocupacional, victi_situacion_ocupacional_otro,
  victima_relacion_inculpado, inculpado_sexo, inculpado_identidad_genero,
  inculpado_identidad_genero_otro, inculpado_tr_edad, inculpado_18_anios_o_mas,
  inculpado_clase, inculpado_otro_clase, inculpado_relacion_victima

38,126 filas -> ~16,734 hechos unicos (multiples filas por hecho: victima + imputado)

Uso:
  DATABASE_URL="postgresql://..." python scripts/ingesta/sat-homicidios.py [--dry-run] [--inspect]
"""

import os
import sys
import csv
import time
import uuid
from collections import defaultdict
from datetime import datetime
try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:  # pragma: no cover
    # El driver solo hace falta para escribir en la base. El modo --dry-run y los
    # tests del mapeo de columnas no lo necesitan, así que importarlo de forma
    # obligatoria impedía correrlos en una máquina sin psycopg2 instalado.
    psycopg2 = None
    execute_values = None

CSV_PATH = "data/snic/SAT-HD-BU_2017-2024.csv"
SEPARATOR = ";"
BATCH_SIZE = 500
FUENTE_NOMBRE = "SAT-SNIC"

DATABASE_URL = os.environ.get("DATABASE_URL")

# tipos_delito.codigo_snic es TEXT desde la migración
# 20260324190907_codigo_snic_to_string. Nunca comparar ni insertar un entero acá.
CODIGO_SNIC_HOMICIDIO_DOLOSO = "1"

_fuente_id = None
_tipo_delito_hd_id = None

# ════════════════════════════════════════════
# MAPEO DE COLUMNAS DE hechos_delictivos
# ════════════════════════════════════════════
# Cada entrada es (clave_en_el_diccionario, identificador_sql).
#
# Los dos roles son distintos y antes estaban mezclados en una sola lista. Los
# campos SAT se crearon en camelCase entrecomillado (ver
# prisma/migrations/20260323085453_add_sat_detail_columns) porque el modelo de
# Prisma no les puso @map, así que en SQL hay que citarlos. Pero la clave del
# diccionario que arma construir_registro() NO lleva comillas.
#
# Al usar la misma lista para ambas cosas, h.get('"lugarHecho"') devolvía None y
# once columnas de detalle de la víctima y del victimario se escribían vacías,
# mientras el SQL quedaba sintácticamente válido. El camino de --dry-run leía las
# claves correctas, así que la prueba en seco mostraba los datos completos y era
# ciega al defecto.
HECHO_CAMPOS = [
    # (clave del dict, identificador SQL)
    ("id", "id"),
    ("tipo_delito_id", "tipo_delito_id"),
    ("ubicacion_id", "ubicacion_id"),
    ("fuente_id", "fuente_id"),
    ("anio", "anio"),
    ("mes", "mes"),
    ("fecha_hecho", "fecha_hecho"),
    ("cantidad_hechos", "cantidad_hechos"),
    ("cantidad_victimas", "cantidad_victimas"),
    ("es_agregado", "es_agregado"),
    ("confianza", "confianza"),
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
    # Columnas SAT. Las que van entre comillas en SQL son camelCase en la base.
    ("hora", "hora"),
    ("lugarHecho", '"lugarHecho"'),
    ("subtipo", "subtipo"),
    ("medioComision", '"medioComision"'),
    ("medioDetalle", '"medioDetalle"'),
    ("victimaSexo", '"victimaSexo"'),
    ("victimaEdad", '"victimaEdad"'),
    ("victimaRangoEdad", '"victimaRangoEdad"'),
    ("contexto", "contexto"),
    ("vinculoVictimaVictimario", '"vinculoVictimaVictimario"'),
    ("femicidio", "femicidio"),
    ("victimarioSexo", '"victimarioSexo"'),
    ("victimarioEdad", '"victimarioEdad"'),
    ("situacionVictimario", '"situacionVictimario"'),
    ("cantidadImputados", '"cantidadImputados"'),
]

HECHO_CLAVES = [clave for clave, _ in HECHO_CAMPOS]
HECHO_SQL = [ident for _, ident in HECHO_CAMPOS]


def verificar_mapeo_columnas(registro):
    """
    Comprueba que toda clave declarada en HECHO_CAMPOS exista en el registro que
    arma construir_registro(). Devuelve la lista de claves faltantes.

    Es la red que atrapa exactamente el defecto que estuvo activo: si alguien
    vuelve a mezclar identificadores SQL con claves de diccionario, o renombra un
    campo en construir_registro sin actualizar el mapeo, la ingesta aborta en vez
    de escribir NULL en silencio sobre datos de víctimas.
    """
    return [clave for clave in HECHO_CLAVES if clave not in registro]

PROVINCIAS_CENTROIDES = {
    "02": {"latitud": -34.6037, "longitud": -58.3816},
    "06": {"latitud": -34.9965, "longitud": -64.9673},
    "10": {"latitud": -24.1836, "longitud": -65.4152},
    "14": {"latitud": -31.4201, "longitud": -64.1888},
    "18": {"latitud": -28.8550, "longitud": -57.9562},
    "22": {"latitud": -27.4698, "longitud": -58.9718},
    "26": {"latitud": -43.3000, "longitud": -65.1000},
    "30": {"latitud": -33.0139, "longitud": -58.2513},
    "34": {"latitud": -27.4698, "longitud": -58.8306},
    "38": {"latitud": -22.1059, "longitud": -65.4036},
    "42": {"latitud": -36.6167, "longitud": -64.2833},
    "46": {"latitud": -28.4993, "longitud": -65.7774},
    "50": {"latitud": -32.8895, "longitud": -68.8458},
    "54": {"latitud": -27.3623, "longitud": -55.9408},
    "58": {"latitud": -41.7644, "longitud": -68.3303},
    "62": {"latitud": -40.8136, "longitud": -68.3593},
    "66": {"latitud": -24.9420, "longitud": -60.6039},
    "70": {"latitud": -29.8815, "longitud": -67.4738},
    "74": {"latitud": -33.2967, "longitud": -66.3347},
    "78": {"latitud": -51.6238, "longitud": -69.2168},
    "82": {"latitud": -29.8828, "longitud": -67.7091},
    "86": {"latitud": -28.0716, "longitud": -65.2042},
    "90": {"latitud": -27.3306, "longitud": -55.1149},
    "94": {"latitud": -54.8075, "longitud": -68.3020},
}

NULOS = {"", "-", "...", "s/d", "sin datos", "sin especificar", "NA",
         "se desconoce", "ns/nc", "sin dato", "no corresponde",
         "no aplica", "9", "99", "999"}


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
                if v.strip():
                    print(f"    {h}: {v}")

    with open(CSV_PATH, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=SEPARATOR)
        total = 0
        id_hechos = set()
        tipos_persona = defaultdict(int)
        provs = set()
        anios = set()
        sexos_victima = defaultdict(int)
        clases_arma = defaultdict(int)
        motivos = defaultdict(int)
        con_coords = 0

        for row in reader:
            total += 1
            id_hechos.add(row.get("id_hecho", "").strip())
            tipos_persona[row.get("tipo_persona", "").strip()] += 1
            provs.add(row.get("provincia_nombre", "").strip())
            anios.add(row.get("anio", "").strip())

            vs = row.get("victima_sexo", "").strip()
            if vs:
                sexos_victima[vs] += 1

            ca = row.get("clase_arma", "").strip()
            if ca:
                clases_arma[ca] += 1

            mo = row.get("motivo_origen_registro", "").strip()
            if mo:
                motivos[mo] += 1

            lat = row.get("latitud_radio", "").strip()
            lon = row.get("longitud_radio", "").strip()
            if lat and lon and lat.lower() not in NULOS and lon.lower() not in NULOS:
                con_coords += 1

    print(f"\n Total filas: {total:,}")
    print(f" Hechos unicos: {len(id_hechos):,}")
    print(f" Tipos persona: {dict(tipos_persona)}")
    print(f" Anios: {sorted(anios)}")
    print(f" Provincias: {sorted(provs)}")
    print(f" Filas con coordenadas: {con_coords:,}")
    print(f" victima_sexo: {dict(sorted(sexos_victima.items(), key=lambda x: -x[1])[:6])}")
    print(f" clase_arma: {dict(sorted(clases_arma.items(), key=lambda x: -x[1])[:6])}")
    print(f" motivo_origen_registro: {dict(sorted(motivos.items(), key=lambda x: -x[1])[:6])}")
    print(f" Ratio filas/hechos: {total / max(len(id_hechos), 1):.1f}")


def safe_str(val):
    val = val.strip()
    return val if val and val.lower() not in NULOS else None


def safe_int(val):
    val = val.strip()
    if not val or val.lower() in NULOS:
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def safe_float(val):
    val = val.strip().replace(",", ".")
    if not val or val.lower() in NULOS:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def pad_depto_id(raw_id):
    cleaned = raw_id.strip()
    if cleaned and cleaned.isdigit():
        return cleaned.zfill(5)
    return cleaned


def obtener_fuente_id(cur):
    global _fuente_id
    if _fuente_id:
        return _fuente_id

    cur.execute('SELECT id FROM fuentes WHERE nombre = %s', (FUENTE_NOMBRE,))
    row = cur.fetchone()

    if row:
        _fuente_id = row[0]
        print(f"  Fuente: {FUENTE_NOMBRE} -> {_fuente_id}")
    else:
        _fuente_id = str(uuid.uuid4())
        cur.execute(
            'INSERT INTO fuentes (id, nombre, tipo, confianza_default, created_at, updated_at, activa) VALUES (%s, %s, %s, %s, NOW(), NOW(), true)',
            (_fuente_id, FUENTE_NOMBRE, "OFICIAL", "OFICIAL")
        )
        print(f"  Fuente creada: {FUENTE_NOMBRE} -> {_fuente_id}")

    return _fuente_id


def obtener_tipo_delito_homicidio(cur):
    global _tipo_delito_hd_id
    if _tipo_delito_hd_id:
        return _tipo_delito_hd_id

    # codigo_snic es TEXT desde la migración 20260324190907_codigo_snic_to_string.
    # Comparar contra el entero 1 hacía que Postgres rechazara la consulta entera
    # con "operator does not exist: text = integer", así que esta función venía
    # fallando y con ella toda la ingesta SAT. Se compara contra el string '1'.
    cur.execute('''
        SELECT id FROM tipos_delito
        WHERE LOWER(nombre) LIKE '%%homicidio%%doloso%%'
           OR LOWER(nombre) LIKE '%%homicidios dolosos%%'
           OR codigo_snic = %s
        LIMIT 1
    ''', (CODIGO_SNIC_HOMICIDIO_DOLOSO,))
    row = cur.fetchone()

    if row:
        _tipo_delito_hd_id = row[0]
        print(f"  TipoDelito HD: {_tipo_delito_hd_id}")
    else:
        _tipo_delito_hd_id = str(uuid.uuid4())
        cur.execute('''
            INSERT INTO tipos_delito (id, nombre, codigo_snic, categoria)
            VALUES (%s, %s, %s, %s)
        ''', (
            _tipo_delito_hd_id,
            "Homicidios dolosos",
            CODIGO_SNIC_HOMICIDIO_DOLOSO,  # string, no entero: la columna es TEXT
            "CONTRA_PERSONAS",
        ))
        print(f"  TipoDelito creado: Homicidios dolosos -> {_tipo_delito_hd_id}")

    return _tipo_delito_hd_id


def agrupar_por_hecho(csv_path):
    # El CSV está gitignoreado (data/snic/), así que la ausencia es el caso más
    # común al correr esto en una máquina nueva. Un mensaje claro en vez de un
    # traceback de FileNotFoundError.
    if not os.path.isfile(csv_path):
        print(f"\n❌ No se encontró el CSV de entrada: {csv_path}")
        print("   Ese archivo no está en el repositorio (data/snic/ está gitignoreado).")
        print("   Copiá el CSV del SAT a esa ruta antes de correr la ingesta.")
        sys.exit(1)

    grupos = defaultdict(list)
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=SEPARATOR)
        if reader.fieldnames:
            reader.fieldnames = [h.replace("\ufeff", "").strip() for h in reader.fieldnames]
        for row in reader:
            id_hecho = row.get("id_hecho", "").strip()
            if id_hecho:
                grupos[id_hecho].append(row)
    return grupos


def detectar_femicidio(base):
    motivo = base.get("motivo_origen_registro", "").strip().lower()
    motivo_otro = base.get("motivo_origen_registro_otro", "").strip().lower()
    if "femicidio" in motivo or "feminicidio" in motivo:
        return "Si"
    if "femicidio" in motivo_otro or "feminicidio" in motivo_otro:
        return "Si"
    return None


def construir_registro(id_hecho, filas, fuente_id, tipo_delito_id):
    """
    Construye HechoDelictivo + Ubicacion desde filas agrupadas.
    Mapeo exacto: columna CSV -> campo camelCase Prisma.
    """
    victima_filas = [f for f in filas if f.get("tipo_persona", "").strip().lower() in ("victima", "v\u00edctima")]
    imputado_filas = [f for f in filas if f.get("tipo_persona", "").strip().lower() in ("imputado", "imputada")]

    base = filas[0]
    victima = victima_filas[0] if victima_filas else {}
    imputado = imputado_filas[0] if imputado_filas else {}

    anio = safe_int(base.get("anio", ""))
    if not anio:
        return None

    ubicacion_id = f"sat-ubi-{id_hecho}"
    hecho_id = f"sat-hd-{id_hecho}"

    # === UBICACION ===
    # CSV: provincia_id, provincia_nombre, departamento_id, departamento_nombre,
    #      localidad_nombre, latitud_radio, longitud_radio
    depto_raw = base.get("departamento_id", "").strip()
    lat = safe_float(base.get("latitud_radio", ""))
    lon = safe_float(base.get("longitud_radio", ""))

    # Si no hay coordenadas, usar centroide de la provincia
    if lat is None or lon is None:
        prov_id = base.get("provincia_id", "").strip().zfill(2)
        centroide = PROVINCIAS_CENTROIDES.get(prov_id)
        if centroide:
            lat = centroide["latitud"]
            lon = centroide["longitud"]

    ubicacion = {
        "id": ubicacion_id,
        "provincia": safe_str(base.get("provincia_nombre", "")),
        "provincia_id": safe_str(base.get("provincia_id", "")),
        "departamento": safe_str(base.get("departamento_nombre", "")),
        "departamento_id": pad_depto_id(depto_raw) if depto_raw else None,
        "localidad": safe_str(base.get("localidad_nombre", "")),
        "latitud": lat,
        "longitud": lon,
        "es_centroide": lat is not None,
        "fuente_ubicacion": "SAT-SNIC (centroide radio censal)",
        "created_at": datetime.now(),
    }

    # === FECHA ===
    # CSV: fecha_hecho, mes, anio
    fecha_str = safe_str(base.get("fecha_hecho", ""))
    fecha_hecho = None
    if fecha_str:
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
            try:
                fecha_hecho = datetime.strptime(fecha_str, fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue

    mes = safe_int(base.get("mes", ""))

    # === HECHO DELICTIVO ===
    # Mapeo columna CSV -> campo Prisma:
    #   hora_hecho          -> hora
    #   tipo_lugar          -> lugarHecho
    #   tipo_lugar_ampliado -> subtipo
    #   clase_arma          -> medioComision
    #   clase_arma_otro     -> medioDetalle
    #   victima_sexo        -> victimaSexo
    #   victima_tr_edad     -> victimaEdad
    #   victima_18_anios_o_mas -> victimaRangoEdad (mayor/menor)
    #   en_ocasion_otro_delito -> contexto
    #   victima_relacion_inculpado / inculpado_relacion_victima -> vinculoVictimaVictimario
    #   motivo_origen_registro -> femicidio (derivado)
    #   inculpado_sexo      -> victimarioSexo
    #   inculpado_tr_edad   -> victimarioEdad
    #   inculpado_clase     -> situacionVictimario
    #   cant_vic            -> cantidad_victimas
    #   cant_inc            -> cantidadImputados

    mayor_menor = base.get("victima_18_anios_o_mas", "").strip().lower() if victima else ""
    rango_edad = None
    if mayor_menor in ("si", "s\u00ed", "1"):
        rango_edad = "mayor"
    elif mayor_menor in ("no", "0"):
        rango_edad = "menor"

    vinculo = safe_str(victima.get("victima_relacion_inculpado", ""))
    if not vinculo:
        vinculo = safe_str(imputado.get("inculpado_relacion_victima", ""))

    hecho = {
        "id": hecho_id,
        "tipo_delito_id": tipo_delito_id,
        "ubicacion_id": ubicacion_id,
        "fuente_id": fuente_id,
        "anio": anio,
        "mes": mes,
        "fecha_hecho": fecha_hecho or f"{anio}-{mes or 1:02d}-01",
        "cantidad_hechos": 1,
        "cantidad_victimas": safe_int(base.get("cant_vic", "")) or len(victima_filas) or 1,
        "es_agregado": False,
        "confianza": "OFICIAL",
        "created_at": datetime.now(),
        "updated_at": datetime.now(),
        # Columnas nuevas SAT
        "hora": safe_str(base.get("hora_hecho", "")),
        "lugarHecho": safe_str(base.get("tipo_lugar", "")),
        "subtipo": safe_str(base.get("tipo_lugar_ampliado", "")),
        "medioComision": safe_str(base.get("clase_arma", "")),
        "medioDetalle": safe_str(base.get("clase_arma_otro", "")),
        "victimaSexo": safe_str(victima.get("victima_sexo", "")),
        "victimaEdad": safe_int(victima.get("victima_tr_edad", "")),
        "victimaRangoEdad": rango_edad,
        "contexto": safe_str(base.get("en_ocasion_otro_delito", "")),
        "vinculoVictimaVictimario": vinculo,
        "femicidio": detectar_femicidio(base),
        "victimarioSexo": safe_str(imputado.get("inculpado_sexo", "")),
        "victimarioEdad": safe_int(imputado.get("inculpado_tr_edad", "")),
        "situacionVictimario": safe_str(imputado.get("inculpado_clase", "")),
        "cantidadImputados": safe_int(base.get("cant_inc", "")) or len(imputado_filas) or None,
    }

    return hecho, ubicacion


def ingest(dry_run=False):
    if not DATABASE_URL and not dry_run:
        print("Falta DATABASE_URL")
        print('   export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"')
        sys.exit(1)

    print(f"\n{'DRY RUN' if dry_run else 'INGESTA'}: {CSV_PATH}")
    print(f"   -> HechoDelictivo + Ubicacion")

    print("\n Agrupando por id_hecho...")
    grupos = agrupar_por_hecho(CSV_PATH)
    print(f"   {len(grupos):,} hechos unicos")

    if dry_run:
        hechos, ubicaciones, skipped = [], [], 0
        for id_hecho, filas in grupos.items():
            resultado = construir_registro(id_hecho, filas, "fake-fuente", "fake-tipo")
            if resultado:
                hechos.append(resultado[0])
                ubicaciones.append(resultado[1])
            else:
                skipped += 1

        print(f"\n Construidos: {len(hechos):,} hechos | Skipped: {skipped}")

        if hechos:
            anios = sorted(set(h["anio"] for h in hechos if h["anio"]))
            geolocalizados = sum(1 for u in ubicaciones if u["latitud"] and u["longitud"])

            sexos = defaultdict(int)
            for h in hechos:
                sexos[h.get("victimaSexo") or "Sin dato"] += 1

            medios = defaultdict(int)
            for h in hechos:
                medios[h.get("medioComision") or "Sin dato"] += 1

            femicidios = sum(1 for h in hechos if h.get("femicidio") == "Si")

            vinculos = defaultdict(int)
            for h in hechos:
                vinculos[h.get("vinculoVictimaVictimario") or "Sin dato"] += 1

            multi = sum(1 for h in hechos if (h.get("cantidad_victimas") or 1) > 1)
            total_victimas = sum(h.get("cantidad_victimas") or 1 for h in hechos)

            print(f" Anios: {anios}")
            print(f" Geolocalizados: {geolocalizados:,}/{len(hechos):,} ({100*geolocalizados/max(len(hechos),1):.1f}%)")
            print(f" victimaSexo: {dict(sorted(sexos.items(), key=lambda x: -x[1]))}")
            print(f" medioComision (top 5): {dict(sorted(medios.items(), key=lambda x: -x[1])[:5])}")
            print(f" Femicidios detectados: {femicidios}")
            print(f" Vinculo (top 5): {dict(sorted(vinculos.items(), key=lambda x: -x[1])[:5])}")
            print(f" Hechos multi-victima: {multi}")
            print(f" Total victimas: {total_victimas:,}")

            print(f"\n Ejemplo hecho #1:")
            h, u = hechos[0], ubicaciones[0]
            for k, v in h.items():
                if v is not None and k not in ("tipo_delito_id", "fuente_id"):
                    print(f"   {k}: {v}")
            print(f"   --- ubicacion ---")
            for k, v in u.items():
                if v is not None:
                    print(f"   {k}: {v}")

        print("\n Dry run completo.")
        return

    if psycopg2 is None:
        print("\n❌ psycopg2 no está instalado y hace falta para escribir en la base.")
        print("   Instalalo con: pip install psycopg2-binary")
        print("   O corré con --dry-run, que no necesita driver.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    fuente_id = obtener_fuente_id(cur)
    tipo_delito_id = obtener_tipo_delito_homicidio(cur)
    conn.commit()

    print(" Construyendo registros...")
    hechos, ubicaciones, skipped = [], [], 0
    for id_hecho, filas in grupos.items():
        resultado = construir_registro(id_hecho, filas, fuente_id, tipo_delito_id)
        if resultado:
            hechos.append(resultado[0])
            ubicaciones.append(resultado[1])
        else:
            skipped += 1

    print(f" {len(hechos):,} hechos | Skipped: {skipped}")

    start = time.time()

    # --- Columnas fijas para batch insert ---
    UBI_COLS = [
        "id", "provincia", "provincia_id", "departamento", "departamento_id",
        "localidad", "latitud", "longitud", "es_centroide", "fuente_ubicacion"
    ]
    # Verificación previa: si el mapeo de columnas no coincide con lo que arma
    # construir_registro(), abortar antes de escribir una sola fila. Escribir
    # NULL sobre datos de víctimas ya cargados es peor que no correr.
    if hechos:
        faltantes = verificar_mapeo_columnas(hechos[0])
        if faltantes:
            print(f"\n❌ ABORTADO: HECHO_CAMPOS declara claves que el registro no tiene: {faltantes}")
            print("   Corregí el mapeo antes de correr la ingesta. No se escribió nada.")
            sys.exit(1)

    # Armar tuples con columnas fijas (None para valores faltantes)
    ubi_tuples = [tuple(u.get(c) for c in UBI_COLS) for u in ubicaciones]
    hecho_tuples = [tuple(h.get(c) for c in HECHO_CLAVES) for h in hechos]

    ubi_cols_str = ", ".join(UBI_COLS)
    ubi_update = ", ".join([f"{c} = EXCLUDED.{c}" for c in UBI_COLS if c != "id"])
    SQL_UBI = f'''
        INSERT INTO ubicaciones ({ubi_cols_str}) VALUES %s
        ON CONFLICT (id) DO UPDATE SET {ubi_update}
    '''

    hecho_cols_str = ", ".join(HECHO_SQL)
    # COALESCE en el UPDATE: un re-run solo sobrescribe cuando trae un valor
    # nuevo, y nunca reemplaza un dato ya cargado por NULL. Sin esto, cualquier
    # regresión futura en el armado del registro vaciaría en silencio las
    # columnas de detalle de las filas SAT ya existentes, porque los ids son
    # deterministas (sat-hd-{id_hecho}) y todas caen en el ON CONFLICT.
    # updated_at se excluye del COALESCE porque siempre debe reflejar la corrida.
    hecho_update = ", ".join([
        f"{ident} = EXCLUDED.{ident}"
        if ident == "updated_at"
        else f"{ident} = COALESCE(EXCLUDED.{ident}, hechos_delictivos.{ident})"
        for ident in HECHO_SQL
        if ident != "id"
    ])
    SQL_HECHO = f'''
        INSERT INTO hechos_delictivos ({hecho_cols_str}) VALUES %s
        ON CONFLICT (id) DO UPDATE SET {hecho_update}
    '''

    PAGE_SIZE = 1000
    inserted = 0
    errors = 0

    # 1. Ubicaciones primero (FK)
    print("  Insertando ubicaciones...")
    for i in range(0, len(ubi_tuples), PAGE_SIZE):
        batch = ubi_tuples[i : i + PAGE_SIZE]
        try:
            execute_values(cur, SQL_UBI, batch, page_size=PAGE_SIZE)
            conn.commit()
        except Exception as e:
            print(f"  Ubicacion error batch {i}: {e}")
            errors += 1
            conn.rollback()

    elapsed = time.time() - start
    print(f"  {len(ubi_tuples):,} ubicaciones en {elapsed:.1f}s")

    # 2. Hechos
    print("  Insertando hechos...")
    for i in range(0, len(hecho_tuples), PAGE_SIZE):
        batch = hecho_tuples[i : i + PAGE_SIZE]
        try:
            execute_values(cur, SQL_HECHO, batch, page_size=PAGE_SIZE)
            conn.commit()
            inserted += len(batch)
        except Exception as e:
            print(f"  Hecho error batch {i}: {e}")
            errors += 1
            conn.rollback()

        elapsed = time.time() - start
        rate = inserted / elapsed if elapsed > 0 else 0
        print(f"  {inserted:,}/{len(hecho_tuples):,} ({elapsed:.1f}s, {rate:.0f} hechos/s)")

    cur.close()
    conn.close()
    elapsed = time.time() - start
    print(f"\n Ingesta completa: {inserted:,} hechos + ubicaciones en {elapsed:.1f}s")
    if errors:
        print(f" Errores: {errors}")


if __name__ == "__main__":
    if "--inspect" in sys.argv:
        inspect_csv()
    elif "--dry-run" in sys.argv:
        ingest(dry_run=True)
    else:
        ingest()