"""
Cruza HECHO_CAMPOS de la ingesta SAT contra las columnas reales de
prisma/schema.prisma.

EL DEFECTO QUE MOTIVÓ ESTA GUARDA
Al agregar `requiereRevision` a `HECHO_CAMPOS` (fix de detectar_femicidio),
se asumió que seguía el mismo patrón que las demás columnas SAT de la lista
—camelCase, entrecomillada— sin chequear su `@map` real en schema.prisma.
`requiereRevision` sí tiene `@map("requiere_revision")`: a diferencia de las
columnas SAT nuevas (que no tienen `@map` y por eso son camelCase en la base),
es un campo más viejo, ya mapeado a snake_case. El SQL quedaba apuntando a una
columna que no existe — `"requiereRevision"` en vez de `requiere_revision`.

Encontrado por OpenCode Go corriendo el runbook, ANTES de tocar producción:
detectó que la ingesta real fallaría en el primer batch de hechos, con el
dry-run pasando igual (no hace INSERT) y los 19 tests de ese momento en verde
(afirmaban el identificador equivocado, así que no lo atrapaban).

POR QUÉ verificar_mapeo_columnas() NO LO ATRAPA
Esa función valida que el diccionario que arma construir_registro() tenga
todas las claves declaradas — es una guarda sobre Python, no sobre SQL. Nunca
mira si el identificador de HECHO_SQL corresponde a una columna real de la
base. Esta guarda cierra ese hueco cruzando contra el schema.

Se corre con la biblioteca estándar, sin dependencias:
    python3 -m unittest discover -s tests/ingesta -p 'test_*.py'
"""

import importlib.util
import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / "scripts" / "ingesta" / "sat-homicidios.py"
SCHEMA = RAIZ / "prisma" / "schema.prisma"


def cargar_modulo():
    spec = importlib.util.spec_from_file_location("sat_homicidios", SCRIPT)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


sat = cargar_modulo()


def bloque_hecho_delictivo():
    """El texto del modelo HechoDelictivo, de 'model HechoDelictivo {' al '}' que lo cierra."""
    texto = SCHEMA.read_text(encoding="utf-8")
    inicio = texto.index("model HechoDelictivo")
    fin = texto.index("\n}", inicio)
    return texto[inicio:fin]


def columna_real(campo, bloque):
    """
    La columna real de un campo del modelo, según schema.prisma: el valor de
    @map si lo tiene, o el propio nombre del campo si no. None si el campo no
    aparece en el bloque.
    """
    m = re.search(rf"^\s*{re.escape(campo)}\s+\S.*$", bloque, re.MULTILINE)
    if not m:
        return None
    mapa = re.search(r'@map\("(\w+)"\)', m.group(0))
    return mapa.group(1) if mapa else campo


# Las claves de HECHO_CAMPOS que son literalmente el nombre de un campo de
# Prisma (a diferencia de "tipo_delito_id", "fecha_hecho", etc., que ya están
# escritas como el nombre de columna y no como el campo — esas las cubre
# TestMapeoDeColumnas en test_sat_columnas.py).
CAMPOS_PRISMA_A_VERIFICAR = [
    "hora",
    "lugarHecho",
    "subtipo",
    "medioComision",
    "medioDetalle",
    "victimaSexo",
    "victimaEdad",
    "victimaRangoEdad",
    "contexto",
    "vinculoVictimaVictimario",
    "femicidio",
    "requiereRevision",
    "victimarioSexo",
    "victimarioEdad",
    "situacionVictimario",
    "cantidadImputados",
]


class TestColumnasContraSchemaPrisma(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bloque = bloque_hecho_delictivo()
        cls.mapa_hecho_campos = dict(sat.HECHO_CAMPOS)

    def test_el_bloque_del_modelo_se_encuentra(self):
        # Si esto falla, todos los demás tests de esta clase son falsos
        # positivos por no encontrar nada — hay que verlo primero.
        self.assertIn("requiereRevision", self.bloque)
        self.assertIn("model HechoDelictivo", self.bloque[:30])

    def test_todos_los_campos_a_verificar_existen_en_HECHO_CAMPOS(self):
        # Si alguien saca uno de estos campos de HECHO_CAMPOS, que falle acá
        # y no en silencio.
        for campo in CAMPOS_PRISMA_A_VERIFICAR:
            self.assertIn(campo, self.mapa_hecho_campos, f"falta {campo} en HECHO_CAMPOS")

    def test_cada_identificador_sql_coincide_con_la_columna_real(self):
        for campo in CAMPOS_PRISMA_A_VERIFICAR:
            with self.subTest(campo=campo):
                columna = columna_real(campo, self.bloque)
                self.assertIsNotNone(
                    columna, f"{campo} no aparece como campo de HechoDelictivo en schema.prisma"
                )

                identificador = self.mapa_hecho_campos[campo]
                sin_comillas = identificador.strip('"')

                self.assertEqual(
                    sin_comillas,
                    columna,
                    f"HECHO_CAMPOS dice que {campo} es la columna {identificador!r}, "
                    f"pero schema.prisma dice que es {columna!r}",
                )

                # Si la columna real tiene mayúsculas, el identificador SQL
                # tiene que ir entrecomillado — Postgres pliega a minúsculas
                # lo que no está entre comillas.
                necesita_comillas = columna != columna.lower()
                esta_entrecomillado = identificador.startswith('"')
                self.assertEqual(
                    esta_entrecomillado,
                    necesita_comillas,
                    f"{campo}: columna {columna!r} "
                    + (
                        "tiene mayúsculas, el identificador SQL debe ir entrecomillado"
                        if necesita_comillas
                        else "es snake_case, el identificador SQL NO debe ir entrecomillado"
                    ),
                )

    def test_requiere_revision_especificamente_no_va_entrecomillada(self):
        # El caso concreto que motivó esta guarda, nombrado explícitamente
        # para que el mensaje de fallo sea inmediato si se reintroduce.
        self.assertEqual(self.mapa_hecho_campos["requiereRevision"], "requiere_revision")

    def test_columna_real_devuelve_none_para_un_campo_inexistente(self):
        self.assertIsNone(columna_real("estoNoExiste", self.bloque))

    def test_columna_real_respeta_el_map_cuando_existe(self):
        self.assertEqual(columna_real("requiereRevision", self.bloque), "requiere_revision")

    def test_columna_real_usa_el_nombre_del_campo_sin_map(self):
        self.assertEqual(columna_real("victimaSexo", self.bloque), "victimaSexo")


if __name__ == "__main__":
    unittest.main()
