#!/usr/bin/env python3
"""
Tests de la auditoría del catálogo SNIC.

Lo que se verifica es que el script encuentre las desalineaciones que importan y
que no invente las que no existen. Un auditor que reporta falsos positivos se
ignora a los dos días, y ahí deja de servir.

Correr:
  python -m unittest discover -s tests/ingesta -p 'test_*.py'
desde la raíz del repo.
"""

import os
import sys
import tempfile
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(RAIZ, "scripts", "ingesta"))

import importlib

auditar_mod = importlib.import_module("auditar-catalogo-snic")

FIXTURE = os.path.join(RAIZ, "tests", "ingesta", "fixtures", "snic-catalogo-muestra.csv")


def escribir_csv(texto):
    """Deja un CSV temporal en disco y devuelve la ruta."""
    f = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
    f.write(texto)
    f.close()
    return f.name


CABECERA = (
    "anio;provincia_id;provincia_nombre;departamento_id;departamento_nombre;"
    "codigo_delito_snic_id;codigo_delito_snic_nombre;cantidad_hechos;cantidad_victimas\n"
)


class TestLecturaCSV(unittest.TestCase):
    def setUp(self):
        self.catalogo = auditar_mod.leer_catalogo_csv(FIXTURE)

    def test_un_csv_ausente_devuelve_none_y_no_explota(self):
        # El CSV no está en el repo, así que este es el camino habitual en CI.
        self.assertIsNone(auditar_mod.leer_catalogo_csv("no/existe/nada.csv"))

    def test_agrupa_por_codigo(self):
        self.assertEqual(set(self.catalogo), {"1", "3", "4", "15", "99"})

    def test_las_filas_sin_codigo_se_ignoran(self):
        # La fixture trae una fila con el código vacío.
        self.assertNotIn("", self.catalogo)

    def test_cuenta_filas_y_suma_hechos(self):
        self.assertEqual(self.catalogo["1"]["filas"], 3)
        self.assertEqual(self.catalogo["1"]["hechos"], 12 + 240 + 10)

    def test_los_faltantes_del_snic_no_rompen_la_suma(self):
        # cantidad_victimas viene como '-', 's/d' y '...' en las filas de robos.
        # Eso no debe abortar la lectura ni sumar basura.
        self.assertEqual(self.catalogo["15"]["hechos"], 1200 + 1150 + 900)

    def test_registra_los_anios(self):
        self.assertEqual(self.catalogo["1"]["anios"], {"2023", "2024"})

    def test_guarda_todas_las_redacciones_de_un_mismo_codigo(self):
        # El código 15 aparece como 'Robos' dos veces y 'Robo' una.
        self.assertEqual(dict(self.catalogo["15"]["nombres"]), {"Robos": 2, "Robo": 1})

    def test_el_nombre_principal_es_el_mayoritario(self):
        self.assertEqual(auditar_mod._nombre_principal(self.catalogo["15"]), "Robos")

    def test_aborta_con_mensaje_claro_si_el_csv_no_es_el_esperado(self):
        ruta = escribir_csv("otra;cosa;totalmente\n1;2;3\n")
        try:
            with self.assertRaises(SystemExit) as ctx:
                auditar_mod.leer_catalogo_csv(ruta)
            self.assertIn("codigo_delito_snic_id", str(ctx.exception))
        finally:
            os.unlink(ruta)


class TestLecturaSeed(unittest.TestCase):
    def test_lee_el_catalogo_real_del_repo(self):
        catalogo, duplicados = auditar_mod.leer_catalogo_seed(
            os.path.join(RAIZ, "prisma", "seed.ts")
        )
        self.assertEqual(catalogo["1"], "Homicidios dolosos")
        self.assertEqual(catalogo["4"], "Homicidios culposos por otros hechos")
        self.assertGreater(len(catalogo), 25, "el catálogo del SNIC tiene ~32 códigos")
        self.assertEqual(duplicados, [], "seed.ts no debería repetir códigos")


class TestNormalizacionDeNombres(unittest.TestCase):
    """
    El comparador no debe gritar por diferencias de forma, y sí por diferencias
    de significado. Si confunde las dos, el reporte se vuelve ruido.
    """

    def test_singular_y_plural_son_lo_mismo(self):
        self.assertEqual(
            auditar_mod._normalizar("Homicidios dolosos"),
            auditar_mod._normalizar("Homicidio doloso"),
        )

    def test_los_acentos_no_cuentan(self):
        self.assertEqual(
            auditar_mod._normalizar("Delitos contra la integridad sexual"),
            auditar_mod._normalizar("delitos contra la integridad sexual"),
        )

    def test_el_orden_de_las_palabras_no_cuenta(self):
        self.assertEqual(
            auditar_mod._normalizar("Muertes en siniestros viales"),
            auditar_mod._normalizar("Siniestros viales, muertes"),
        )

    def test_femicidio_y_culposo_son_distintos(self):
        # Esta es la confusión que motivó todo: si el normalizador las tratara
        # como equivalentes, el script no habría encontrado nada.
        self.assertNotEqual(
            auditar_mod._normalizar("Femicidio / Transfemicidio"),
            auditar_mod._normalizar("Homicidios culposos por otros hechos"),
        )

    def test_doloso_y_culposo_son_distintos(self):
        self.assertNotEqual(
            auditar_mod._normalizar("Homicidios dolosos"),
            auditar_mod._normalizar("Homicidios culposos"),
        )


class TestOrden(unittest.TestCase):
    def test_ordena_numericamente(self):
        # Con orden alfabético, el 10 iría antes del 2 y la tabla sería ilegible.
        codigos = ["10", "2", "1", "31", "3"]
        self.assertEqual(
            sorted(codigos, key=auditar_mod._orden), ["1", "2", "3", "10", "31"]
        )

    def test_tolera_codigos_no_numericos(self):
        codigos = ["2", "X1", "1"]
        self.assertEqual(sorted(codigos, key=auditar_mod._orden), ["1", "2", "X1"])


class TestAuditoria(unittest.TestCase):
    """El corazón: qué se reporta y qué no."""

    @staticmethod
    def _titulos(hallazgos, solo_bloqueantes=False):
        return [
            h.titulo for h in hallazgos
            if not solo_bloqueantes or h.bloqueante
        ]

    def test_reporta_un_codigo_del_csv_que_el_catalogo_no_tiene(self):
        # La ingesta descarta esas filas en silencio: es un problema, no un aviso.
        hallazgos = auditar_mod.auditar(
            catalogo_csv={"1": {"nombres": {"Homicidios dolosos": 1}, "filas": 1,
                                "hechos": 5, "anios": {"2024"}},
                          "99": {"nombres": {"Delito raro": 1}, "filas": 1,
                                 "hechos": 3, "anios": {"2024"}}},
            catalogo_seed={"1": "Homicidios dolosos"},
            dup_seed=[],
            prompt={},
            descripcion={},
            whitelist=None,
        )
        titulos = self._titulos(hallazgos, solo_bloqueantes=True)
        self.assertTrue(
            any("códigos que seed.ts no tiene" in t for t in titulos),
            f"esperaba el hallazgo del código faltante, hubo: {titulos}",
        )

    def test_reporta_el_prompt_ofreciendo_un_codigo_inexistente(self):
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None,
            catalogo_seed={"1": "Homicidios dolosos"},
            dup_seed=[],
            prompt={"0": "Muerte violenta en investigación", "1": "Homicidio doloso"},
            descripcion={},
            whitelist=None,
        )
        titulos = self._titulos(hallazgos, solo_bloqueantes=True)
        self.assertTrue(
            any("código 0, que no existe" in t for t in titulos),
            f"esperaba el hallazgo del código 0, hubo: {titulos}",
        )

    def test_el_codigo_inexistente_trae_las_opciones_para_resolverlo(self):
        # Es el hallazgo que necesita una decisión de negocio, así que el reporte
        # tiene que ofrecer las alternativas y no solo señalar el problema.
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None,
            catalogo_seed={"1": "Homicidios dolosos"},
            dup_seed=[],
            prompt={"0": "Muerte violenta en investigación"},
            descripcion={},
            whitelist=None,
        )
        h = next(h for h in hallazgos if "no existe" in h.titulo)
        self.assertIsNotNone(h.remedio, "este hallazgo debe explicar cómo resolverse")
        # Las dos salidas, y la advertencia sobre el falsy del 0.
        self.assertIn("Sacar el código 0", h.remedio)
        self.assertIn("Crear la categoría", h.remedio)
        self.assertIn("falsy", h.remedio)

    def test_reporta_el_prompt_y_el_catalogo_significando_cosas_distintas(self):
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None,
            catalogo_seed={"4": "Homicidios culposos por otros hechos"},
            dup_seed=[],
            prompt={"4": "Femicidio / Transfemicidio"},
            descripcion={},
            whitelist=None,
        )
        titulos = self._titulos(hallazgos, solo_bloqueantes=True)
        self.assertTrue(
            any("no significan lo mismo con el código 4" in t for t in titulos),
            f"esperaba la discrepancia del código 4, hubo: {titulos}",
        )

    def test_no_reporta_nada_cuando_todo_coincide(self):
        # Un auditor que siempre encuentra algo no sirve para nada.
        hallazgos = auditar_mod.auditar(
            catalogo_csv={"1": {"nombres": {"Homicidios dolosos": 10}, "filas": 10,
                                "hechos": 50, "anios": {"2024"}}},
            catalogo_seed={"1": "Homicidios dolosos"},
            dup_seed=[],
            prompt={"1": "Homicidio doloso"},
            descripcion={"1": "Homicidio doloso"},
            whitelist=["1"],
        )
        self.assertEqual(hallazgos, [], f"no debería haber hallazgos: {hallazgos}")

    def test_el_plural_del_snic_no_genera_un_falso_positivo(self):
        # El SNIC escribe en plural y el prompt en singular. Eso no es un problema.
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None,
            catalogo_seed={"1": "Homicidios dolosos"},
            dup_seed=[],
            prompt={"1": "Homicidio doloso"},
            descripcion={"1": "Homicidio doloso"},
            whitelist=["1"],
        )
        self.assertEqual(hallazgos, [])

    def test_reporta_codigos_duplicados_en_seed(self):
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None, catalogo_seed={"1": "X"}, dup_seed=["1"],
            prompt={}, descripcion={}, whitelist=None,
        )
        self.assertTrue(any(h.bloqueante for h in hallazgos))
        self.assertIn("más de una vez", hallazgos[0].titulo)

    def test_reporta_el_pipeline_rechazando_un_codigo_que_el_prompt_ofrece(self):
        hallazgos = auditar_mod.auditar(
            catalogo_csv=None,
            catalogo_seed={"1": "Homicidios dolosos", "2": "Homicidios dolosos en grado de tentativa"},
            dup_seed=[],
            prompt={"1": "Homicidio doloso", "2": "Homicidio doloso en grado de tentativa"},
            descripcion={"1": "Homicidio doloso", "2": "Homicidio doloso en grado de tentativa"},
            whitelist=["1"],
        )
        titulos = self._titulos(hallazgos, solo_bloqueantes=True)
        self.assertTrue(
            any("rechaza códigos que el prompt sí ofrece" in t for t in titulos),
            f"hubo: {titulos}",
        )

    def test_varias_redacciones_del_mismo_codigo_es_aviso_no_problema(self):
        # El SNIC cambiando la redacción entre años no invalida el dato.
        hallazgos = auditar_mod.auditar(
            catalogo_csv={"15": {"nombres": {"Robos": 5, "Robo": 1}, "filas": 6,
                                 "hechos": 100, "anios": {"2023", "2024"}}},
            catalogo_seed={"15": "Robos"},
            dup_seed=[], prompt={}, descripcion={}, whitelist=None,
        )
        relevantes = [h for h in hallazgos if "más de un nombre" in h.titulo]
        self.assertEqual(len(relevantes), 1)
        self.assertFalse(relevantes[0].bloqueante, "no debería bloquear")


class TestEjecucionCompleta(unittest.TestCase):
    def test_corre_de_punta_a_punta_y_escribe_el_documento(self):
        salida = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
        salida.close()
        try:
            codigo = auditar_mod.main([
                "--csv", FIXTURE, "--salida", salida.name,
            ])
            # Sin --check siempre termina en 0, aunque haya hallazgos.
            self.assertEqual(codigo, 0)

            with open(salida.name, encoding="utf-8") as f:
                doc = f.read()

            self.assertIn("# Catálogo de tipos de delito del SNIC", doc)
            self.assertIn("No editar a mano", doc)
            self.assertIn("Homicidios dolosos", doc)
            self.assertIn("99", doc, "el código desconocido debe figurar")
            self.assertIn("### Problemas", doc)
        finally:
            os.unlink(salida.name)

    def test_check_falla_cuando_hay_problemas(self):
        codigo = auditar_mod.main(["--csv", FIXTURE, "--no-escribir", "--check"])
        self.assertEqual(codigo, 1, "con hallazgos bloqueantes tiene que fallar")

    def test_sin_csv_igual_produce_el_documento(self):
        # El caso de CI: el CSV no está y el script tiene que seguir sirviendo.
        salida = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
        salida.close()
        try:
            auditar_mod.main(["--csv", "no/existe.csv", "--salida", salida.name])
            with open(salida.name, encoding="utf-8") as f:
                doc = f.read()
            self.assertIn("CSV oficial no estaba disponible", doc)
            self.assertIn("prisma/seed.ts", doc)
            # Antes acá se afirmaba la presencia de "Cómo resolverlo" y "Crear la
            # categoría", porque el código 0 estaba desalineado: el prompt lo
            # ofrecía pero seed.ts no lo tenía, así que el auditor emitía ese
            # hallazgo en cada corrida. O sea que el test fijaba la existencia
            # del bug.
            #
            # Ya se resolvió (el 0 es una categoría real del catálogo), así que
            # sin CSV y con todo alineado no debe haber hallazgos. La cobertura
            # de la sección de remediación se movió al test de la fixture, que
            # sí tiene discrepancias de verdad.
            self.assertIn("| 0 | Muerte violenta en investigación |", doc)
            self.assertNotIn(
                "Cómo resolverlo", doc,
                "sin CSV y con el catálogo alineado no debería haber hallazgos"
            )
        finally:
            os.unlink(salida.name)


class TestRenderDelRemedio(unittest.TestCase):
    """
    El bloque <details>Cómo resolverlo</details> solo se emite para hallazgos que
    traen un `remedio`.

    Hasta ahora su única cobertura era indirecta: el hallazgo del código 0
    —prompt lo ofrecía, seed.ts no lo tenía— llevaba remedio, así que aparecía
    en cada corrida y un test lo daba por sentado. Al resolver ese desajuste, el
    camino de render quedó sin probar. Este test lo cubre directo, sin depender
    de que exista una discrepancia real en el catálogo.
    """

    def _documento(self, hallazgos):
        salida = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
        salida.close()
        try:
            auditar_mod.escribir_documento(
                salida.name,
                catalogo_csv={}, catalogo_seed={}, prompt={}, descripcion={},
                whitelist=[], hallazgos=hallazgos,
            )
            with open(salida.name, encoding="utf-8") as f:
                return f.read()
        finally:
            os.unlink(salida.name)

    def test_un_hallazgo_con_remedio_emite_el_desplegable(self):
        doc = self._documento([
            auditar_mod.Hallazgo(
                "Título de prueba", "Detalle del problema.",
                bloqueante=True, remedio="Opción A: hacer esto.",
            )
        ])
        self.assertIn("Cómo resolverlo", doc)
        self.assertIn("Opción A: hacer esto.", doc)
        self.assertIn("<details>", doc)

    def test_un_hallazgo_sin_remedio_no_lo_emite(self):
        doc = self._documento([
            auditar_mod.Hallazgo("Sin remedio", "Detalle.", bloqueante=True)
        ])
        self.assertIn("Sin remedio", doc)
        self.assertNotIn("Cómo resolverlo", doc)

    def test_tambien_aplica_a_las_observaciones(self):
        # La rama de avisos tiene su propio bloque de render, duplicado del de
        # problemas: si uno se toca y el otro no, esto lo detecta.
        doc = self._documento([
            auditar_mod.Hallazgo(
                "Aviso con remedio", "Detalle.",
                bloqueante=False, remedio="Revisar tal cosa.",
            )
        ])
        self.assertIn("### Observaciones", doc)
        self.assertIn("Cómo resolverlo", doc)
        self.assertIn("Revisar tal cosa.", doc)


if __name__ == "__main__":
    unittest.main()
