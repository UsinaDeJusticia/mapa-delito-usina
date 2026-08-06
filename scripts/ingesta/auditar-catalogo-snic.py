#!/usr/bin/env python3
"""
Auditoría del catálogo de tipos de delito del SNIC.
Mapa del Delito - Usina de Justicia

POR QUÉ EXISTE
El código SNIC de cada delito aparece en cuatro lugares que tienen que decir lo
mismo y nadie verificaba que lo hicieran:

  1. El CSV oficial del SNIC        (la verdad)
  2. prisma/seed.ts                 (el catálogo que se carga en la base)
  3. El prompt del LLM              (el vocabulario que se le ofrece al modelo)
  4. La whitelist del pipeline      (qué códigos se aceptan al guardar)

Cuando se desalinean no falla nada a la vista: los hechos se guardan con el tipo
de delito equivocado, o se descartan en silencio. Un femicidio guardado con el
código de "homicidio culposo" no rompe ninguna query — simplemente sale mal en el
mapa público.

Este script compara los cuatro y escribe el resultado en docs/catalogo-snic.md.

SIN EL CSV TAMBIÉN SIRVE
El CSV del SNIC no está en el repositorio (pesa cientos de MB y está en
.gitignore). Si no aparece, el script audita igual lo que sí puede —seed.ts
contra el prompt contra la whitelist— y avisa que la comparación contra la fuente
oficial quedó pendiente. Así corre en CI todos los días y no solo en la máquina
que tiene el CSV.

USO
  python scripts/ingesta/auditar-catalogo-snic.py
  python scripts/ingesta/auditar-catalogo-snic.py --csv otra/ruta.csv
  python scripts/ingesta/auditar-catalogo-snic.py --check     # exit 1 si hay problemas
  python scripts/ingesta/auditar-catalogo-snic.py --no-escribir

No toca la base de datos. Solo lee archivos y escribe un .md.
"""

import argparse
import csv
import os
import re
import sys
from collections import defaultdict

# ─────────────────────────────────────────────────────────────────────────────
# Rutas, relativas a la raíz del repo
# ─────────────────────────────────────────────────────────────────────────────

CSV_DEFAULT = "data/snic/snic-departamentos-anual.csv"
SEPARADOR = ";"
SEED = "prisma/seed.ts"
PROMPT = "src/lib/mapa/openrouter.ts"
PIPELINE = "scripts/pipeline/scrapear-medios.ts"
SALIDA = "docs/catalogo-snic.md"

COL_CODIGO = "codigo_delito_snic_id"
COL_NOMBRE = "codigo_delito_snic_nombre"
COL_ANIO = "anio"
COL_HECHOS = "cantidad_hechos"


# ─────────────────────────────────────────────────────────────────────────────
# Lectura de cada fuente
# ─────────────────────────────────────────────────────────────────────────────

def leer_catalogo_csv(ruta):
    """
    Códigos y nombres tal como los publica el SNIC.

    Devuelve {codigo: {"nombres": {nombre: filas}, "filas": n, "hechos": n,
                       "anios": set}} o None si el archivo no está.

    Los nombres se guardan en un dict y no en un string porque el archivo oficial
    puede traer el mismo código con más de una redacción entre años; eso es en sí
    un hallazgo y hay que poder verlo.
    """
    if not os.path.exists(ruta):
        return None

    catalogo = defaultdict(
        lambda: {"nombres": defaultdict(int), "filas": 0, "hechos": 0, "anios": set()}
    )

    with open(ruta, "r", encoding="utf-8-sig") as f:
        lector = csv.DictReader(f, delimiter=SEPARADOR)
        if lector.fieldnames is None or COL_CODIGO not in lector.fieldnames:
            raise SystemExit(
                f"ERROR: {ruta} no tiene la columna '{COL_CODIGO}'.\n"
                f"       Columnas encontradas: {lector.fieldnames}\n"
                f"       ¿Es el CSV de departamentos del SNIC y el separador es '{SEPARADOR}'?"
            )

        for fila in lector:
            codigo = (fila.get(COL_CODIGO) or "").strip()
            if not codigo:
                continue
            nombre = (fila.get(COL_NOMBRE) or "").strip()
            entrada = catalogo[codigo]
            entrada["filas"] += 1
            if nombre:
                entrada["nombres"][nombre] += 1
            anio = (fila.get(COL_ANIO) or "").strip()
            if anio:
                entrada["anios"].add(anio)
            entrada["hechos"] += _entero(fila.get(COL_HECHOS))

    return dict(catalogo)


def _entero(valor):
    """Los faltantes del SNIC vienen como '-', '...', 's/d' o vacío."""
    if valor is None:
        return 0
    valor = valor.strip()
    if not valor or valor in ("-", "...", "s/d", "S/D", "///"):
        return 0
    try:
        return int(float(valor))
    except (ValueError, TypeError):
        return 0


def leer_catalogo_seed(ruta=SEED):
    """Códigos y nombres que seed.ts carga en tipos_delito."""
    with open(ruta, "r", encoding="utf-8") as f:
        contenido = f.read()

    patron = re.compile(
        r"codigoSnic:\s*'([^']+)'\s*,\s*nombre:\s*'((?:[^'\\]|\\.)*)'"
    )
    catalogo = {}
    duplicados = []
    for codigo, nombre in patron.findall(contenido):
        nombre = nombre.replace("\\'", "'")
        if codigo in catalogo:
            duplicados.append(codigo)
        catalogo[codigo] = nombre
    return catalogo, duplicados


def leer_vocabulario_prompt(ruta=PROMPT):
    """
    Códigos que el prompt le ofrece al LLM.

    Salen de dos lugares del mismo archivo, y también tienen que coincidir entre
    sí: la lista del prompt ("- 1 = Homicidio doloso...") y el mapa
    SNIC_DESCRIPCION que traduce el código a texto para guardarlo.
    """
    with open(ruta, "r", encoding="utf-8") as f:
        contenido = f.read()

    # Lista del prompt: "- 1 = Homicidio doloso (aclaraciones)."
    del_prompt = {}
    for codigo, texto in re.findall(r"^-\s*(\d+)\s*=\s*(.+)$", contenido, re.MULTILINE):
        del_prompt[codigo] = _nombre_corto(texto)

    # Mapa SNIC_DESCRIPCION: "1: 'Homicidio doloso',"
    de_descripcion = {}
    bloque = re.search(
        r"SNIC_DESCRIPCION[^{]*\{(.*?)\}", contenido, re.DOTALL
    )
    if bloque:
        for codigo, nombre in re.findall(r"(\d+):\s*'([^']*)'", bloque.group(1)):
            de_descripcion[codigo] = nombre

    return del_prompt, de_descripcion


def _nombre_corto(texto):
    """Deja el nombre sin los paréntesis de aclaración ni el punto final."""
    texto = re.sub(r"\s*\([^)]*\)", "", texto)
    return texto.strip().rstrip(".").strip()


def leer_whitelist_pipeline(ruta=PIPELINE):
    """Códigos que el pipeline acepta al momento de guardar el hecho."""
    with open(ruta, "r", encoding="utf-8") as f:
        contenido = f.read()
    m = re.search(r"!\[([\d,\s]+)\]\.includes\(\s*datos\.codigoSnicEstimado", contenido)
    if not m:
        return None
    return [c.strip() for c in m.group(1).split(",") if c.strip()]


# ─────────────────────────────────────────────────────────────────────────────
# Comparación
# ─────────────────────────────────────────────────────────────────────────────

def _normalizar_sangria(texto):
    """
    Normaliza la indentación de un texto multilínea.

    Los detalles se escriben con f-strings dentro de código indentado, así que
    arrastran los espacios del archivo fuente. Las viñetas quedan con dos
    espacios de sangría y el resto se alinea al margen; entre una viñeta y el
    párrafo siguiente se abre una línea en blanco, o Markdown lo absorbe dentro
    de la lista.
    """
    salida = []
    venia_vineta = False
    for linea in texto.split("\n"):
        limpia = linea.strip()
        if not limpia:
            continue
        es_vineta = limpia.startswith("- ")
        if venia_vineta and not es_vineta:
            salida.append("")
        salida.append(f"  {limpia}" if es_vineta else limpia)
        venia_vineta = es_vineta
    return salida


class Hallazgo:
    """Una discrepancia. `bloqueante` distingue un error de una observación."""

    def __init__(self, titulo, detalle, bloqueante=True, remedio=None):
        self.titulo = titulo
        self.detalle = detalle
        self.bloqueante = bloqueante
        # Qué hacer al respecto. Se llena cuando la salida no es obvia o cuando
        # requiere una decisión que el script no puede tomar solo.
        self.remedio = remedio

    def lineas(self):
        """El detalle, línea por línea, con la sangría normalizada."""
        return _normalizar_sangria(self.detalle)

    def lineas_remedio(self):
        """El remedio, si lo hay, con la misma normalización."""
        return _normalizar_sangria(self.remedio) if self.remedio else []

    def __repr__(self):
        marca = "ERROR" if self.bloqueante else "aviso"
        return f"[{marca}] {self.titulo}"


def auditar(catalogo_csv, catalogo_seed, dup_seed, prompt, descripcion, whitelist):
    hallazgos = []

    if dup_seed:
        hallazgos.append(Hallazgo(
            "seed.ts declara el mismo código más de una vez",
            "Códigos repetidos: " + ", ".join(sorted(set(dup_seed))) +
            ". El upsert deja el último y el resto se pierde en silencio.",
        ))

    # ── seed.ts contra el CSV oficial ──
    if catalogo_csv is not None:
        solo_csv = sorted(set(catalogo_csv) - set(catalogo_seed), key=_orden)
        if solo_csv:
            lineas = []
            for c in solo_csv:
                nombre = _nombre_principal(catalogo_csv[c])
                filas = catalogo_csv[c]["filas"]
                hechos = catalogo_csv[c]["hechos"]
                lineas.append(
                    f"  - código {c} ({nombre}): {filas:,} {_plural(filas, 'fila')}, "
                    f"{hechos:,} {_plural(hechos, 'hecho')}"
                )
            hallazgos.append(Hallazgo(
                "El CSV oficial trae códigos que seed.ts no tiene",
                "La ingesta descarta estas filas porque no encuentra el TipoDelito:\n"
                + "\n".join(lineas),
            ))

        solo_seed = sorted(set(catalogo_seed) - set(catalogo_csv), key=_orden)
        if solo_seed:
            # Se listan hasta 12 para que el resumen en terminal siga siendo
            # legible; el documento generado tiene la tabla completa.
            muestra = ", ".join(f"{c} ({catalogo_seed[c]})" for c in solo_seed[:12])
            if len(solo_seed) > 12:
                muestra += f", y {len(solo_seed) - 12} más"
            hallazgos.append(Hallazgo(
                f"seed.ts declara {len(solo_seed)} códigos que no aparecen en el CSV",
                "No es necesariamente un error —el CSV puede cubrir menos años o "
                "menos delitos que el catálogo completo—, pero conviene revisarlo: "
                + muestra,
                bloqueante=False,
            ))

        for codigo in sorted(set(catalogo_csv) & set(catalogo_seed), key=_orden):
            nombres = catalogo_csv[codigo]["nombres"]
            if len(nombres) > 1:
                hallazgos.append(Hallazgo(
                    f"El CSV usa más de un nombre para el código {codigo}",
                    "Redacciones encontradas: "
                    + "; ".join(f"'{n}' ({v:,} {_plural(v, 'fila')})" for n, v in sorted(
                        nombres.items(), key=lambda kv: -kv[1])),
                    bloqueante=False,
                ))

            oficial = _nombre_principal(catalogo_csv[codigo])
            nuestro = catalogo_seed[codigo]
            if _normalizar(oficial) != _normalizar(nuestro):
                hallazgos.append(Hallazgo(
                    f"El nombre del código {codigo} no coincide con el oficial",
                    f"CSV oficial: '{oficial}'\n     seed.ts:     '{nuestro}'",
                    bloqueante=False,
                ))

    # ── El prompt contra seed.ts ──
    # Este es el desalineamiento que más daño hace: el LLM devuelve un código que
    # el catálogo no tiene, o que significa otra cosa, y el hecho se guarda mal o
    # se descarta.
    for codigo, nombre in sorted(prompt.items(), key=lambda kv: _orden(kv[0])):
        if codigo not in catalogo_seed:
            hallazgos.append(Hallazgo(
                f"El prompt ofrece el código {codigo}, que no existe en el catálogo",
                f"El prompt lo llama '{nombre}'. Cuando el LLM lo devuelve, el "
                f"pipeline no encuentra el TipoDelito y descarta el hecho.",
                remedio=(
                    "Hay dos salidas y la elección es de negocio, no técnica:\n"
                    f"  - **Sacar el código {codigo} del prompt** y de la whitelist del "
                    "pipeline, y mapear esos casos a un código que sí exista. Es lo "
                    "conservador: no agrega nada al catálogo oficial.\n"
                    f"  - **Crear la categoría** en `prisma/seed.ts`. Pero ojo: si el "
                    f"código {codigo} no está en el catálogo del SNIC, se estaría "
                    "guardando un valor no oficial en un campo llamado `codigo_snic`, "
                    "y se pierde la comparabilidad con la estadística del Ministerio. "
                    "El mismo problema que tuvo femicidio.\n"
                    "  Verificá primero contra el CSV oficial si el código existe o no.\n"
                    f"  Aparte, en `{PIPELINE}` la búsqueda del tipo es "
                    "`datos.codigoSnicEstimado ? ...`, y en JavaScript el 0 es falsy: "
                    "si el código en cuestión es 0, ni siquiera se intenta la búsqueda. "
                    "Eso hay que corregirlo igual, cualquiera sea la decisión anterior."
                ),
            ))
        elif _normalizar(nombre) != _normalizar(catalogo_seed[codigo]):
            hallazgos.append(Hallazgo(
                f"El prompt y el catálogo no significan lo mismo con el código {codigo}",
                f"prompt:   '{nombre}'\n     seed.ts:  '{catalogo_seed[codigo]}'",
            ))

    # ── SNIC_DESCRIPCION contra el prompt ──
    for codigo in sorted(set(prompt) | set(descripcion), key=_orden):
        if codigo in prompt and codigo not in descripcion:
            hallazgos.append(Hallazgo(
                f"SNIC_DESCRIPCION no tiene el código {codigo} que el prompt ofrece",
                "El hecho se guarda con tipoHecho en null.",
                bloqueante=False,
            ))
        elif codigo in descripcion and codigo not in prompt:
            hallazgos.append(Hallazgo(
                f"SNIC_DESCRIPCION tiene un código {codigo} que el prompt no ofrece",
                f"Lo llama '{descripcion[codigo]}'. Probablemente sea código muerto.",
                bloqueante=False,
            ))

    # ── La whitelist del pipeline contra el prompt ──
    if whitelist is not None:
        sobran = sorted(set(whitelist) - set(prompt), key=_orden)
        if sobran:
            hallazgos.append(Hallazgo(
                "El pipeline acepta códigos que el prompt no ofrece",
                "Códigos: " + ", ".join(sobran),
                bloqueante=False,
            ))
        faltan = sorted(set(prompt) - set(whitelist), key=_orden)
        if faltan:
            hallazgos.append(Hallazgo(
                "El pipeline rechaza códigos que el prompt sí ofrece",
                "El LLM los va a devolver y el pipeline los va a descartar: "
                + ", ".join(faltan),
            ))

    return hallazgos


def _plural(n, singular):
    return singular if n == 1 else singular + "s"


def _orden(codigo):
    """Ordena numéricamente cuando se puede, para que 10 no vaya antes que 2."""
    return (0, int(codigo)) if codigo.isdigit() else (1, 0, codigo)


def _nombre_principal(entrada):
    """El nombre con el que aparece la mayoría de las filas de ese código."""
    if not entrada["nombres"]:
        return "(sin nombre)"
    return max(entrada["nombres"].items(), key=lambda kv: kv[1])[0]


def _normalizar(texto):
    """
    Compara nombres sin tropezar con diferencias de forma.

    El SNIC escribe en plural ('Homicidios dolosos') y el prompt en singular
    ('Homicidio doloso'); eso no es una discrepancia de significado y no vale la
    pena reportarlo. Lo que sí importa es que un código diga 'femicidio' en un
    lado y 'culposo' en el otro.
    """
    t = texto.lower().strip()
    for a, b in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ñ", "n")):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    palabras = [p.rstrip("s") for p in t.split() if p not in ("de", "del", "la", "el", "los", "las", "en", "por", "y")]
    return " ".join(sorted(palabras))


# ─────────────────────────────────────────────────────────────────────────────
# Reporte
# ─────────────────────────────────────────────────────────────────────────────

def escribir_documento(ruta, catalogo_csv, catalogo_seed, prompt, descripcion,
                       whitelist, hallazgos):
    L = []
    L.append("# Catálogo de tipos de delito del SNIC")
    L.append("")
    L.append("> Generado por `scripts/ingesta/auditar-catalogo-snic.py`.")
    L.append("> **No editar a mano**: los cambios se pierden en la próxima corrida.")
    L.append("> Para regenerarlo: `python scripts/ingesta/auditar-catalogo-snic.py`")
    L.append("")
    L.append("El código SNIC de cada delito vive en cuatro lugares que tienen que decir")
    L.append("lo mismo. Cuando se desalinean no falla nada a la vista: los hechos se")
    L.append("guardan con el tipo equivocado, o se descartan en silencio.")
    L.append("")

    # ── Estado ──
    bloqueantes = [h for h in hallazgos if h.bloqueante]
    avisos = [h for h in hallazgos if not h.bloqueante]

    L.append("## Estado")
    L.append("")
    if catalogo_csv is None:
        L.append("⚠️ **El CSV oficial no estaba disponible en esta corrida.** La comparación")
        L.append("contra la fuente oficial quedó pendiente; lo que sigue compara únicamente")
        L.append("`seed.ts`, el prompt del LLM y la whitelist del pipeline entre sí.")
        L.append("")
        L.append(f"Para completarla, conseguí el CSV en `{CSV_DEFAULT}` y volvé a correr el script.")
    elif not hallazgos:
        L.append("✅ Las cuatro fuentes coinciden.")
    else:
        L.append(f"Se encontraron **{len(bloqueantes)} problemas** y {len(avisos)} observaciones.")
    L.append("")

    # ── Hallazgos ──
    if hallazgos:
        L.append("## Hallazgos")
        L.append("")
        if bloqueantes:
            L.append("### Problemas")
            L.append("")
            for h in bloqueantes:
                L.append(f"- **{h.titulo}**")
                for linea in h.lineas():
                    L.append(f"  {linea}")
                if h.remedio:
                    L.append("")
                    L.append("  <details><summary>Cómo resolverlo</summary>")
                    L.append("")
                    for linea in h.lineas_remedio():
                        L.append(f"  {linea}" if linea else "")
                    L.append("")
                    L.append("  </details>")
                L.append("")
        if avisos:
            L.append("### Observaciones")
            L.append("")
            for h in avisos:
                L.append(f"- **{h.titulo}**")
                for linea in h.lineas():
                    L.append(f"  {linea}")
                if h.remedio:
                    L.append("")
                    L.append("  <details><summary>Cómo resolverlo</summary>")
                    L.append("")
                    for linea in h.lineas_remedio():
                        L.append(f"  {linea}" if linea else "")
                    L.append("")
                    L.append("  </details>")
                L.append("")

    # ── Catálogo oficial ──
    if catalogo_csv is not None:
        anios = sorted({a for e in catalogo_csv.values() for a in e["anios"]})
        L.append("## Catálogo oficial (según el CSV del SNIC)")
        L.append("")
        if anios:
            L.append(f"Años cubiertos: {anios[0]}–{anios[-1]}. "
                     f"{len(catalogo_csv)} códigos distintos.")
            L.append("")
        L.append("| Código | Nombre oficial | En seed.ts | Filas | Hechos |")
        L.append("|---|---|---|---:|---:|")
        for c in sorted(catalogo_csv, key=_orden):
            e = catalogo_csv[c]
            en_seed = "sí" if c in catalogo_seed else "**NO**"
            L.append(
                f"| {c} | {_nombre_principal(e)} | {en_seed} | "
                f"{e['filas']:,} | {e['hechos']:,} |"
            )
        L.append("")

    # ── Catálogo cargado ──
    L.append("## Catálogo cargado en la base (`prisma/seed.ts`)")
    L.append("")
    L.append(f"{len(catalogo_seed)} tipos de delito.")
    L.append("")
    L.append("| Código | Nombre |")
    L.append("|---|---|")
    for c in sorted(catalogo_seed, key=_orden):
        L.append(f"| {c} | {catalogo_seed[c]} |")
    L.append("")

    # ── Vocabulario del pipeline ──
    L.append("## Vocabulario que el pipeline le ofrece al LLM")
    L.append("")
    L.append("Solo un subconjunto: el pipeline busca homicidios, no todo el catálogo.")
    L.append("")
    L.append("| Código | En el prompt | En SNIC_DESCRIPCION | En el catálogo |")
    L.append("|---|---|---|---|")
    for c in sorted(set(prompt) | set(descripcion), key=_orden):
        L.append(
            f"| {c} | {prompt.get(c, '—')} | {descripcion.get(c, '—')} | "
            f"{catalogo_seed.get(c, '**no existe**')} |"
        )
    L.append("")
    if whitelist is not None:
        L.append(f"Códigos que el pipeline acepta al guardar: {', '.join(whitelist)}.")
        L.append("")

    with open(ruta, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def imprimir_resumen(catalogo_csv, catalogo_seed, hallazgos):
    print()
    print("=" * 70)
    print("  AUDITORÍA DEL CATÁLOGO SNIC")
    print("=" * 70)
    print()
    if catalogo_csv is None:
        print(f"  CSV oficial:  NO DISPONIBLE ({CSV_DEFAULT})")
        print("                Se audita seed.ts vs prompt vs pipeline solamente.")
    else:
        print(f"  CSV oficial:  {len(catalogo_csv)} códigos")
    print(f"  seed.ts:      {len(catalogo_seed)} códigos")
    print()

    bloqueantes = [h for h in hallazgos if h.bloqueante]
    avisos = [h for h in hallazgos if not h.bloqueante]

    if not hallazgos:
        print("  Sin discrepancias.")
        print()
        return

    for grupo, etiqueta in ((bloqueantes, "PROBLEMA"), (avisos, "aviso")):
        for h in grupo:
            print(f"  [{etiqueta}] {h.titulo}")
            for linea in h.lineas():
                print(f"      {linea}")
            if h.remedio:
                print(f"      → Cómo resolverlo: ver {SALIDA}")
            print()


def main(argv=None):
    p = argparse.ArgumentParser(description="Audita el catálogo de tipos de delito del SNIC.")
    p.add_argument("--csv", default=CSV_DEFAULT, help=f"Ruta al CSV del SNIC (default: {CSV_DEFAULT})")
    p.add_argument("--salida", default=SALIDA, help=f"Documento a generar (default: {SALIDA})")
    p.add_argument("--no-escribir", action="store_true", help="Solo reporta, no escribe el .md")
    p.add_argument("--check", action="store_true", help="Termina con exit 1 si hay problemas bloqueantes")
    args = p.parse_args(argv)

    catalogo_csv = leer_catalogo_csv(args.csv)
    catalogo_seed, dup_seed = leer_catalogo_seed()
    prompt, descripcion = leer_vocabulario_prompt()
    whitelist = leer_whitelist_pipeline()

    hallazgos = auditar(catalogo_csv, catalogo_seed, dup_seed, prompt, descripcion, whitelist)

    imprimir_resumen(catalogo_csv, catalogo_seed, hallazgos)

    if not args.no_escribir:
        escribir_documento(args.salida, catalogo_csv, catalogo_seed, prompt,
                           descripcion, whitelist, hallazgos)
        print(f"  Documento escrito en {args.salida}")
        print()

    if args.check and any(h.bloqueante for h in hallazgos):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
