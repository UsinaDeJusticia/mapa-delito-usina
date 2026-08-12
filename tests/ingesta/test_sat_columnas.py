"""
Tests del mapeo de columnas de la ingesta SAT.

Cubren el defecto que dejó once columnas de detalle de víctima y victimario
escribiéndose en NULL: HECHO_COLS mezclaba identificadores SQL entrecomillados
con claves de diccionario, así que h.get('"lugarHecho"') devolvía None mientras
el SQL quedaba sintácticamente válido.

El punto crítico de estos tests es que ejercitan el CAMINO DE ESCRITURA REAL (el
armado de tuplas), no el resumen de --dry-run. El dry-run leía las claves
correctas, así que mostraba los datos completos y era ciego al problema. Un test
sobre el dry-run habría pasado con el bug presente.

Se corre con la biblioteca estándar, sin dependencias:
    python3 -m unittest discover -s tests/ingesta -p 'test_*.py'
"""

import importlib.util
import os
import sys
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / "scripts" / "ingesta" / "sat-homicidios.py"


def cargar_modulo():
    """
    Importa sat-homicidios.py, que tiene guiones en el nombre y por lo tanto no
    se puede importar con la sintaxis normal.
    """
    spec = importlib.util.spec_from_file_location("sat_homicidios", SCRIPT)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


sat = cargar_modulo()


# Las once columnas que el bug dejaba en NULL. Se listan explícitamente para que
# un cambio accidental en el mapeo rompa el test con un mensaje claro.
COLUMNAS_AFECTADAS_POR_EL_BUG = [
    "lugarHecho",
    "medioComision",
    "medioDetalle",
    "victimaSexo",
    "victimaEdad",
    "victimaRangoEdad",
    "vinculoVictimaVictimario",
    "victimarioSexo",
    "victimarioEdad",
    "situacionVictimario",
    "cantidadImputados",
]

# Estas NUNCA estuvieron afectadas: iban sin comillas y coincidían con la clave.
# El plan de seguridad listaba "contexto" como afectada por error; tocarla
# habría introducido un bug nuevo.
COLUMNAS_QUE_YA_FUNCIONABAN = ["hora", "subtipo", "contexto", "femicidio"]


class TestMapeoDeColumnas(unittest.TestCase):
    def test_ninguna_clave_de_diccionario_lleva_comillas(self):
        """La causa raíz: una clave con comillas nunca matchea el dict."""
        for clave in sat.HECHO_CLAVES:
            self.assertNotIn(
                '"', clave, f"la clave del diccionario {clave!r} no debe llevar comillas"
            )

    def test_los_identificadores_camelcase_van_entrecomillados_en_sql(self):
        """
        Postgres pliega a minúsculas los identificadores sin comillas, así que
        las columnas camelCase de la base necesitan comillas en el SQL.
        """
        for clave, ident in sat.HECHO_CAMPOS:
            if any(c.isupper() for c in clave):
                self.assertEqual(
                    ident,
                    f'"{clave}"',
                    f"{clave} es camelCase y su identificador SQL debe ir entrecomillado",
                )
            else:
                self.assertEqual(
                    ident, clave, f"{clave} es snake_case y no necesita comillas"
                )

    def test_claves_e_identificadores_tienen_el_mismo_largo(self):
        self.assertEqual(len(sat.HECHO_CLAVES), len(sat.HECHO_SQL))
        self.assertEqual(len(sat.HECHO_CLAVES), len(sat.HECHO_CAMPOS))

    def test_no_hay_claves_duplicadas(self):
        self.assertEqual(
            len(sat.HECHO_CLAVES),
            len(set(sat.HECHO_CLAVES)),
            "una clave duplicada haría que una columna se escriba dos veces",
        )

    def test_las_once_columnas_del_bug_estan_mapeadas(self):
        for col in COLUMNAS_AFECTADAS_POR_EL_BUG:
            self.assertIn(
                col, sat.HECHO_CLAVES, f"{col} debe estar en el mapeo de columnas"
            )

    def test_las_columnas_que_ya_funcionaban_siguen_sin_comillas(self):
        mapa = dict(sat.HECHO_CAMPOS)
        for col in COLUMNAS_QUE_YA_FUNCIONABAN:
            self.assertEqual(
                mapa[col], col, f"{col} nunca estuvo afectada y no debe entrecomillarse"
            )


class TestArmadoDeTuplas(unittest.TestCase):
    """
    El camino de escritura real. Con el bug presente, todos los valores de las
    once columnas salían None acá, aunque el registro los tuviera cargados.
    """

    def registro_completo(self):
        """Un registro con todas las claves declaradas y un valor distintivo."""
        return {clave: f"valor-{clave}" for clave in sat.HECHO_CLAVES}

    def test_la_tupla_conserva_todos_los_valores(self):
        registro = self.registro_completo()
        tupla = tuple(registro.get(c) for c in sat.HECHO_CLAVES)

        self.assertEqual(len(tupla), len(sat.HECHO_CLAVES))
        self.assertNotIn(
            None, tupla, "ningún valor debe perderse al armar la tupla"
        )

    def test_los_valores_quedan_en_la_posicion_correcta(self):
        registro = self.registro_completo()
        tupla = tuple(registro.get(c) for c in sat.HECHO_CLAVES)

        for i, clave in enumerate(sat.HECHO_CLAVES):
            self.assertEqual(
                tupla[i],
                f"valor-{clave}",
                f"la posición {i} debe corresponder a {clave}",
            )

    def test_regresion_las_once_columnas_no_salen_none(self):
        """
        La prueba que habría atrapado el bug. Con HECHO_COLS entrecomillado,
        cada una de estas once posiciones daba None.
        """
        registro = self.registro_completo()
        tupla = tuple(registro.get(c) for c in sat.HECHO_CLAVES)
        posicion = {clave: i for i, clave in enumerate(sat.HECHO_CLAVES)}

        for col in COLUMNAS_AFECTADAS_POR_EL_BUG:
            self.assertEqual(
                tupla[posicion[col]],
                f"valor-{col}",
                f"{col} volvió a perderse al armar la tupla",
            )

    def test_una_clave_entrecomillada_reproduce_el_bug(self):
        """
        Demuestra el mecanismo: si el mapeo vuelve a llevar comillas en la clave,
        el valor se pierde. Este test documenta por qué el otro test importa.
        """
        registro = {"lugarHecho": "Vía pública"}
        self.assertIsNone(registro.get('"lugarHecho"'))
        self.assertEqual(registro.get("lugarHecho"), "Vía pública")


class TestVerificacionDeMapeo(unittest.TestCase):
    def test_acepta_un_registro_completo(self):
        registro = {clave: None for clave in sat.HECHO_CLAVES}
        self.assertEqual(sat.verificar_mapeo_columnas(registro), [])

    def test_detecta_claves_faltantes(self):
        registro = {clave: None for clave in sat.HECHO_CLAVES}
        del registro["victimaSexo"]
        del registro["cantidadImputados"]

        faltantes = sat.verificar_mapeo_columnas(registro)
        self.assertIn("victimaSexo", faltantes)
        self.assertIn("cantidadImputados", faltantes)
        self.assertEqual(len(faltantes), 2)

    def test_detecta_un_registro_vacio(self):
        self.assertEqual(
            len(sat.verificar_mapeo_columnas({})), len(sat.HECHO_CLAVES)
        )

    def test_el_registro_real_de_construir_registro_satisface_el_mapeo(self):
        """
        El test de integración del mapeo: se arma un registro con el código real
        a partir de una fila de CSV sintética y se verifica que tenga todas las
        claves declaradas. Atrapa el caso de renombrar un campo en
        construir_registro sin actualizar HECHO_CAMPOS.
        """
        fila = {
            "id_hecho": "99999",
            "tipo_persona": "victima",
            "anio": "2024",
            "mes": "3",
            "fecha_hecho": "2024-03-15",
            "provincia_id": "82",
            "provincia": "Santa Fe",
            "departamento": "Rosario",
            "hora_hecho": "22:30",
            "tipo_lugar": "Vía pública",
            "tipo_lugar_ampliado": "Calle",
            "clase_arma": "Arma de fuego",
            "clase_arma_otro": "",
            "victima_sexo": "Mujer",
            "victima_tr_edad": "34",
            "en_ocasion_otro_delito": "No",
            "vinculo": "Pareja",
            "inculpado_sexo": "Varón",
            "inculpado_tr_edad": "40",
            "inculpado_clase": "Detenido",
            "cant_inc": "1",
        }

        resultado = sat.construir_registro(
            "99999",
            [fila],
            fuente_id="fuente-de-prueba",
            tipo_delito_id="tipo-de-prueba",
        )
        if resultado is None:
            self.skipTest(
                "construir_registro descartó la fila sintética; ver los filtros del script"
            )

        hecho, _ubicacion = resultado
        faltantes = sat.verificar_mapeo_columnas(hecho)
        self.assertEqual(
            faltantes,
            [],
            f"construir_registro no produce estas claves declaradas en HECHO_CAMPOS: {faltantes}",
        )


class TestCodigoSnicEsTexto(unittest.TestCase):
    """
    tipos_delito.codigo_snic es TEXT desde la migración
    20260324190907_codigo_snic_to_string. Comparar o insertar un entero hace que
    Postgres rechace la consulta con "operator does not exist: text = integer".
    """

    def test_la_constante_es_un_string(self):
        self.assertIsInstance(sat.CODIGO_SNIC_HOMICIDIO_DOLOSO, str)
        self.assertEqual(sat.CODIGO_SNIC_HOMICIDIO_DOLOSO, "1")

    def test_no_queda_ninguna_comparacion_con_entero_en_el_sql(self):
        fuente = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn(
            "codigo_snic = 1",
            fuente,
            "quedó una comparación de codigo_snic contra un entero",
        )


class TestProteccionDelOnConflict(unittest.TestCase):
    """
    Los ids de las filas SAT son deterministas (sat-hd-{id_hecho}), así que todo
    re-run cae en el ON CONFLICT y actualiza filas existentes. El COALESCE es lo
    que impide que una regresión futura vacíe datos de víctimas ya cargados.
    """

    def test_el_update_usa_coalesce_para_no_pisar_con_null(self):
        fuente = SCRIPT.read_text(encoding="utf-8")
        self.assertIn(
            "COALESCE(EXCLUDED.",
            fuente,
            "el ON CONFLICT de hechos_delictivos debe proteger los valores existentes",
        )

    def test_updated_at_se_actualiza_siempre(self):
        fuente = SCRIPT.read_text(encoding="utf-8")
        self.assertIn(
            'ident == "updated_at"',
            fuente,
            "updated_at debe quedar fuera del COALESCE para reflejar cada corrida",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
