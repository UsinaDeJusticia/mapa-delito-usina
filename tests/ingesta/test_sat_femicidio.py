"""
Tests de detección de femicidio en la ingesta SAT.

EL DEFECTO
`detectar_femicidio()` buscaba "femicidio" en `motivo_origen_registro`, una
columna que solo toma cuatro valores administrativos (Denuncia particular /
Intervención policial / Orden judicial / Otros) — ninguno menciona nunca
femicidio. Por eso siempre devolvía None, aunque el organismo sí registra el
dato: vive como texto libre en `en_ocasion_otro_delito_otro`.

Encontrado corriendo el runbook de integración post-Fase-1 contra un CSV real:
`femicidios_totales_pais` daba 0 con datos oficiales que sí traían "Femicidio"
en ese campo.

LAS 5 FILAS REALES DEL DIAGNÓSTICO
Las filas 1, 2 y 5 (mención simple, víctima mujer) y las filas 3-4 (mención
"Tentativa de femicidio", víctima varón) son las que motivaron el diseño de
`detectar_femicidio()`. Se usan tal cual acá, no inventadas, porque la fila 3
es exactamente el caso que un substring-match ingenuo clasificaría mal: la
mención a "femicidio" está en la fila de un policía muerto durante una
tentativa contra otra persona, no en la fila de una mujer asesinada.

Se corre con la biblioteca estándar, sin dependencias:
    python3 -m unittest discover -s tests/ingesta -p 'test_*.py'
"""

import importlib.util
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / "scripts" / "ingesta" / "sat-homicidios.py"


def cargar_modulo():
    spec = importlib.util.spec_from_file_location("sat_homicidios", SCRIPT)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


sat = cargar_modulo()


class TestDeteccionFemicidio(unittest.TestCase):
    """Unidad: detectar_femicidio(base, victima_sexo) -> (femicidio, requiere_revision)."""

    def test_fila_1_femicidio_simple_victima_mujer(self):
        # Entre Ríos, 2017, ex cónyuge/ex pareja.
        base = {"en_ocasion_otro_delito_otro": "Femicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Femenino"), ("Si", False)
        )

    def test_fila_2_femicidio_simple_otra_provincia(self):
        # Salta, 2018, conyuge/pareja — mismo patrón que la fila 1, otro caso real.
        base = {"en_ocasion_otro_delito_otro": "Femicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Femenino"), ("Si", False)
        )

    def test_fila_3_4_tentativa_no_es_femicidio_de_esta_victima(self):
        # Mendoza, 2018. La víctima real de esta fila es un policía varón,
        # muerto durante una tentativa de femicidio contra otra persona que
        # sobrevivió. Es el caso que un substring-match ingenuo rompería.
        base = {"en_ocasion_otro_delito_otro": "Tentativa de femicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Masculino (Policía en servicio)"),
            (None, False),
        )

    def test_tentativa_no_pide_revision_ni_aunque_la_victima_sea_mujer(self):
        # Si algún día aparece una fila "tentativa" con víctima mujer, sigue sin
        # ser un femicidio consumado de ella — por definición de "tentativa".
        base = {"en_ocasion_otro_delito_otro": "Tentativa de femicidio"}
        self.assertEqual(sat.detectar_femicidio(base, "Femenino"), (None, False))

    def test_fila_5_femicidio_simple_denuncia_particular(self):
        # Mendoza, 2018, conyuge/pareja, origen "Denuncia particular" — prueba
        # que el origen del registro no influye en la detección.
        base = {"en_ocasion_otro_delito_otro": "Femicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Femenino"), ("Si", False)
        )

    def test_femicidio_vinculado_se_manda_a_revision_no_se_reclasifica(self):
        # Decisión de Usina: no reclasificar automáticamente. Una persona
        # —a veces un hijo o hija, a veces otro adulto— asesinada por el mismo
        # agresor para dañar a la mujer, no una mujer asesinada directamente.
        for texto in (
            "Femicidio vinculado",
            "Femicidio / femicidio vinculado",
            "Femicidio y femicidios vinculados",
            "Homicidio transversal (femicidio vinculado)",
        ):
            with self.subTest(texto=texto):
                base = {"en_ocasion_otro_delito_otro": texto}
                self.assertEqual(
                    sat.detectar_femicidio(base, "Femenino"), (None, True)
                )

    def test_vinculado_a_revision_aunque_la_victima_sea_varon(self):
        base = {"en_ocasion_otro_delito_otro": "Femicidio vinculado"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Masculino"), (None, True)
        )

    def test_femicidio_seguido_de_suicidio_cuenta_si_la_victima_es_mujer(self):
        base = {"en_ocasion_otro_delito_otro": "Femicidio seguido de suicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Femenino"), ("Si", False)
        )

    def test_transfemicidio_cuenta_igual_que_femicidio(self):
        base = {"en_ocasion_otro_delito_otro": "Transfemicidio"}
        self.assertEqual(
            sat.detectar_femicidio(base, "Femenino"), ("Si", False)
        )

    def test_mencion_simple_sin_sexo_femenino_se_manda_a_revision(self):
        # No se descarta en silencio: alguien tiene que mirar la ficha.
        self.assertEqual(
            sat.detectar_femicidio({"en_ocasion_otro_delito_otro": "Femicidio"}, "Masculino"),
            (None, True),
        )

    def test_mencion_simple_sin_dato_de_sexo_se_manda_a_revision(self):
        for sexo in (None, "", "  ", "Sin dato"):
            with self.subTest(sexo=sexo):
                base = {"en_ocasion_otro_delito_otro": "Femicidio"}
                self.assertEqual(sat.detectar_femicidio(base, sexo), (None, True))

    def test_sin_ninguna_mencion_no_es_femicidio_ni_pide_revision(self):
        # El caso normal: la inmensa mayoría de las filas.
        for texto in (None, "", "No fue en ocasión de otro delito", "Robo"):
            with self.subTest(texto=texto):
                base = {"en_ocasion_otro_delito_otro": texto}
                self.assertEqual(sat.detectar_femicidio(base, "Femenino"), (None, False))

    def test_no_distingue_mayusculas(self):
        base = {"en_ocasion_otro_delito_otro": "FEMICIDIO"}
        self.assertEqual(sat.detectar_femicidio(base, "FEMENINO"), ("Si", False))

    def test_ya_no_mira_motivo_origen_registro(self):
        # Regresión directa del bug: esta columna nunca debería activar la
        # detección, aunque por algún motivo contuviera la palabra.
        base = {
            "en_ocasion_otro_delito_otro": "",
            "motivo_origen_registro": "femicidio",
            "motivo_origen_registro_otro": "femicidio",
        }
        self.assertEqual(sat.detectar_femicidio(base, "Femenino"), (None, False))


class TestIntegracionConstruirRegistro(unittest.TestCase):
    """construir_registro() tiene que propagar femicidio y requiereRevision."""

    @staticmethod
    def _fila(en_ocasion_otro_delito_otro, victima_sexo, id_hecho="1"):
        return {
            "id_hecho": id_hecho,
            "tipo_persona": "victima",
            "anio": "2018",
            "mes": "3",
            "fecha_hecho": "2018-03-15",
            "provincia_id": "50",
            "provincia_nombre": "Mendoza",
            "victima_sexo": victima_sexo,
            "en_ocasion_otro_delito_otro": en_ocasion_otro_delito_otro,
            "en_ocasion_otro_delito": (
                "No fue en ocasión de otro delito"
                if "tentativa" not in en_ocasion_otro_delito_otro.lower()
                else "Si otro delito"
            ),
        }

    def _construir(self, en_ocasion_otro_delito_otro, victima_sexo, id_hecho="1"):
        fila = self._fila(en_ocasion_otro_delito_otro, victima_sexo, id_hecho)
        resultado = sat.construir_registro(
            id_hecho, [fila], fuente_id="fuente-test", tipo_delito_id="tipo-test"
        )
        self.assertIsNotNone(resultado, "construir_registro descartó la fila sintética")
        hecho, _ubicacion = resultado
        return hecho

    def test_femicidio_llega_al_hecho_final(self):
        hecho = self._construir("Femicidio", "Femenino")
        self.assertEqual(hecho["femicidio"], "Si")
        self.assertFalse(hecho["requiereRevision"])

    def test_tentativa_no_marca_nada(self):
        hecho = self._construir("Tentativa de femicidio", "Masculino (Policía en servicio)")
        self.assertIsNone(hecho["femicidio"])
        self.assertFalse(hecho["requiereRevision"])

    def test_vinculado_queda_marcado_para_revision(self):
        hecho = self._construir("Femicidio vinculado", "Masculino")
        self.assertIsNone(hecho["femicidio"])
        self.assertTrue(hecho["requiereRevision"])

    def test_requiereRevision_esta_en_el_mapeo_de_columnas(self):
        # Si alguien saca este campo de HECHO_CAMPOS sin querer, este test lo
        # detecta antes que un INSERT roto contra Neon.
        self.assertIn("requiereRevision", sat.HECHO_CLAVES)
        self.assertIn('"requiereRevision"', sat.HECHO_SQL)

    def test_el_registro_completo_satisface_verificar_mapeo_columnas(self):
        hecho = self._construir("Femicidio", "Femenino")
        self.assertEqual(sat.verificar_mapeo_columnas(hecho), [])


if __name__ == "__main__":
    unittest.main()
