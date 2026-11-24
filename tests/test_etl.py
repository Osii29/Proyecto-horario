"""Pruebas unitarias y de validación de datos para el pipeline ETL."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import requests

from etl import build_data, conexion

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"


class TestConexionETL(unittest.TestCase):
    def test_limpiar_texto_maneja_entidades_mojibake_y_utf8(self):
        self.assertEqual(conexion.limpiar_texto(None), "")
        self.assertEqual(conexion.limpiar_texto("   "), "")
        self.assertEqual(
            conexion.limpiar_texto("ORDO&Ntilde;EZ ROSALES MARTIN"),
            "ORDOÑEZ ROSALES MARTIN",
        )
        self.assertEqual(
            conexion.limpiar_texto("DISEÃ‘O Y ANALISIS DE ALGORITMOS"),
            "DISEÑO Y ANALISIS DE ALGORITMOS",
        )
        self.assertEqual(
            conexion.limpiar_texto("DISEÃ‘O - ORDO&Ntilde;EZ"),
            "DISEÑO - ORDOÑEZ",
        )
        self.assertEqual(
            conexion.limpiar_texto("DISEÑO LOGICO (L)"),
            "DISEÑO LOGICO (L)",
        )

    def test_normalizar_tipo_clase(self):
        incidencias = []
        self.assertEqual(conexion.normalizar_tipo_clase("P", incidencias=incidencias), "PRESENCIAL")
        self.assertEqual(conexion.normalizar_tipo_clase("s", incidencias=incidencias), "SEMIPRESENCIAL")
        self.assertEqual(conexion.normalizar_tipo_clase("A", incidencias=incidencias), "A DISTANCIA")
        self.assertEqual(conexion.normalizar_tipo_clase("H", incidencias=incidencias), "HIBRIDO")
        self.assertEqual(conexion.normalizar_tipo_clase("X", incidencias=incidencias), "SIN ESPECIFICAR")
        self.assertEqual(conexion.normalizar_tipo_clase("", incidencias=incidencias), "SIN ESPECIFICAR")
        self.assertEqual(incidencias, [])

        desconocido = conexion.normalizar_tipo_clase("Z", contexto="test", incidencias=incidencias)
        self.assertEqual(desconocido, "Z")
        self.assertEqual(len(incidencias), 1)
        self.assertEqual(incidencias[0]["tipo"], "tipo_clase_desconocido")

    def test_hora_a_minutos_y_cupo(self):
        self.assertEqual(conexion.hora_a_minutos("07:00"), 420)
        self.assertEqual(conexion.hora_a_minutos("7:30"), 450)
        self.assertEqual(conexion.hora_a_minutos("23:59"), 1439)
        self.assertIsNone(conexion.hora_a_minutos("24:00"))
        self.assertIsNone(conexion.hora_a_minutos("12:60"))
        self.assertIsNone(conexion.hora_a_minutos("sin hora"))

        incidencias = []
        self.assertEqual(conexion.parsear_cupo("45", incidencias=incidencias), 45)
        self.assertIsNone(conexion.parsear_cupo("", incidencias=incidencias))
        self.assertIsNone(conexion.parsear_cupo("LLENO", contexto="g1", incidencias=incidencias))
        self.assertEqual(len(incidencias), 1)
        self.assertEqual(incidencias[0]["tipo"], "cupo_no_numerico")

    def test_parsear_bloques_variantes_br_y_casos_irregulares(self):
        incidencias = []
        bloques_multiples = conexion.parsear_bloques(
            "LU",
            "07:00<br />09:00<br>11:00<br/>12:30",
            contexto="mat1",
            incidencias=incidencias,
        )
        self.assertEqual(
            bloques_multiples,
            [
                {"dia": "LU", "hora_texto": "07:00-09:00", "inicio_min": 420, "fin_min": 540},
                {"dia": "LU", "hora_texto": "11:00-12:30", "inicio_min": 660, "fin_min": 750},
            ],
        )
        self.assertEqual(incidencias, [])

        irregulares = conexion.parsear_bloques(
            "MA",
            "15:00<br />13:00<br />17:00",
            contexto="mat2",
            incidencias=incidencias,
        )
        self.assertEqual(len(irregulares), 2)
        self.assertIsNone(irregulares[0]["inicio_min"])
        self.assertIsNone(irregulares[1]["inicio_min"])
        self.assertEqual([i["tipo"] for i in incidencias], ["bloque_irregular", "bloque_impar"])

    def test_obtener_semestres_ultimo_y_carreras_mock(self):
        resp_sem = MagicMock()
        resp_sem.raise_for_status.return_value = None
        resp_sem.json.return_value = [
            {"id_semestre": "33", "nombre": "2026-1"},
            {"id_semestre": "35", "nombre": "2027-1"},
            {"id_semestre": "34", "nombre": "2026-2"},
        ]

        resp_carr = MagicMock()
        resp_carr.raise_for_status.return_value = None
        resp_carr.json.return_value = [
            {"id_area": "12", "nombre": "INGENIERIA EN COMPUTACION"},
            {"id_area": "3", "nombre": "DISE&Ntilde;O INDUSTRIAL"},
            {"id_area": "3", "nombre": "DISE&Ntilde;O INDUSTRIAL"},
        ]

        session = MagicMock()
        session.get.side_effect = [resp_sem, resp_sem, resp_carr]

        semestres = conexion.obtener_semestres(session=session)
        self.assertEqual([s["id_semestre"] for s in semestres], ["33", "34", "35"])

        ultimo = conexion.obtener_ultimo_semestre(session=session)
        self.assertEqual(ultimo, {"id_semestre": "35", "nombre": "2027-1"})

        carreras = conexion.obtener_carreras(session=session)
        self.assertEqual(
            carreras,
            [
                {"id_area": "3", "nombre": "DISEÑO INDUSTRIAL"},
                {"id_area": "12", "nombre": "INGENIERIA EN COMPUTACION"},
            ],
        )

    def test_obtener_grupos_y_horario_con_reintentos_mock(self):
        resp_grupos = MagicMock()
        resp_grupos.raise_for_status.return_value = None
        resp_grupos.json.return_value = [
            {"grupo": "1005"},
            {"grupo": "1005"},
            {"grupo": "1558"},
            {"grupo": ""},
        ]

        session = MagicMock()
        session.get.side_effect = [
            requests.Timeout("timeout transitorio"),
            resp_grupos,
        ]

        incidencias = []
        with patch("etl.conexion.time.sleep") as mock_sleep:
            grupos = conexion.obtener_grupos(
                sem=35, carr=12, session=session, reintentos=2, incidencias=incidencias
            )

        self.assertEqual(grupos, ["1005", "1558"])
        mock_sleep.assert_called_once()
        self.assertEqual(len(incidencias), 1)
        self.assertEqual(incidencias[0]["tipo"], "grupo_vacio")

        resp_horario = MagicMock()
        resp_horario.raise_for_status.return_value = None
        resp_horario.json.return_value = [
            {
                "clv_materia": "1500",
                "grupo": "1558",
                "nomb_cmateria": "DISEÃ‘O Y ANALISIS DE ALGORITMOS",
                "nomb_prof": "ORDO&Ntilde;EZ MARTIN",
                "clv_salon": "A504",
                "cupo": "60",
                "tipoclase": "P",
                "LU": "",
                "MA": "15:00<br />17:15",
                "MI": "",
                "JU": "15:00<br />17:15",
                "VI": "",
                "SA": "",
            }
        ]
        session.get.side_effect = [resp_horario]
        horarios = conexion.obtener_horario(tipo=2, sem=35, carr=12, grupo="1558", session=session)
        self.assertEqual(len(horarios), 1)
        self.assertEqual(horarios[0]["materia"], "DISEÑO Y ANALISIS DE ALGORITMOS")
        self.assertEqual(horarios[0]["profesor"], "ORDOÑEZ MARTIN")
        self.assertEqual(horarios[0]["cupo"], 60)
        self.assertEqual(horarios[0]["tipo_clase"], "PRESENCIAL")
        self.assertEqual(len(horarios[0]["bloques"]), 2)


class TestBuildDataETL(unittest.TestCase):
    def test_descubrir_objetivos_ultimo_semestre(self):
        with (
            patch(
                "etl.build_data.obtener_ultimo_semestre",
                return_value={"id_semestre": "35", "nombre": "2027-1"},
            ),
            patch(
                "etl.build_data.obtener_carreras",
                return_value=[
                    {"id_area": "2", "nombre": "ARQUITECTURA"},
                    {"id_area": "12", "nombre": "INGENIERIA EN COMPUTACION"},
                ],
            ),
        ):
            ultimo, objetivos = build_data.descubrir_objetivos_ultimo_semestre(
                filtro_carreras={"12"}
            )

        self.assertEqual(ultimo["id_semestre"], "35")
        self.assertEqual(
            objetivos,
            [
                {
                    "sem": "35",
                    "carr": "12",
                    "etiqueta_semestre": "2027-1",
                    "nombre_carrera": "INGENIERIA EN COMPUTACION",
                }
            ],
        )

    def test_extraer_objetivo_tolera_fallo_de_grupo_y_deduplica(self):
        reg_base = {
            "clv_materia": "1500",
            "grupo": "1557",
            "semestre": "35",
            "carrera": "12",
            "materia": "ALGORITMOS",
            "profesor": "PROF A",
            "salon": "A1",
            "cupo": 40,
            "tipo_clase": "PRESENCIAL",
            "bloques": [{"dia": "LU", "hora_texto": "07:00-09:00", "inicio_min": 420, "fin_min": 540}],
        }
        reg_distinto = {**reg_base, "profesor": "PROF B"}

        with (
            patch("etl.build_data.obtener_grupos", return_value=["1557", "1558", "1559"]),
            patch(
                "etl.build_data.obtener_horario",
                side_effect=[
                    [reg_base, dict(reg_base), reg_distinto],
                    requests.Timeout("Error simulado en 1558"),
                    [],
                ],
            ),
        ):
            resultado = build_data.extraer_objetivo(
                sem=35,
                carr=12,
                pausa=0,
                etiqueta_semestre="2027-1",
                nombre_carrera="INGENIERIA EN COMPUTACION",
            )

        meta = resultado["metadata"]
        self.assertEqual(meta["total_grupos_consultados"], 3)
        self.assertEqual(meta["total_grupos_con_datos"], 1)
        self.assertEqual(meta["total_grupos_vacios"], 1)
        self.assertEqual(meta["total_grupos_con_error"], 1)
        self.assertEqual(meta["grupos_fallidos"], ["1558"])
        self.assertEqual(meta["duplicados_omitidos"], 1)
        self.assertEqual(meta["total_registros"], 2)
        ids = [r["id"] for r in resultado["horarios"]]
        self.assertEqual(ids, ["35_12_1500_1557", "35_12_1500_1557_2"])

    def test_guardar_limpiar_y_actualizar_indice_ultimo_semestre(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            build_data.guardar_json(
                tmp_dir / "sem_33_carr_12.json",
                {
                    "metadata": {
                        "semestre": "33",
                        "etiqueta_semestre": "2026-1",
                        "carrera": "12",
                        "nombre_carrera": "COMPUTACION",
                        "generado_en": "2026-01-01T00:00:00Z",
                        "total_registros": 10,
                        "total_materias_unicas": 4,
                        "total_grupos_con_datos": 2,
                    },
                    "horarios": [],
                },
            )
            build_data.guardar_json(
                tmp_dir / "sem_35_carr_12.json",
                {
                    "metadata": {
                        "semestre": "35",
                        "etiqueta_semestre": "2027-1",
                        "carrera": "12",
                        "nombre_carrera": "INGENIERIA EN COMPUTACION",
                        "generado_en": "2026-11-23T00:00:00Z",
                        "total_registros": 20,
                        "total_materias_unicas": 8,
                        "total_grupos_con_datos": 3,
                    },
                    "horarios": [],
                },
            )
            build_data.guardar_json(
                tmp_dir / "sem_35_carr_2.json",
                {
                    "metadata": {
                        "semestre": "35",
                        "etiqueta_semestre": "2027-1",
                        "carrera": "2",
                        "nombre_carrera": "ARQUITECTURA",
                        "generado_en": "2026-11-23T00:00:00Z",
                        "total_registros": 15,
                        "total_materias_unicas": 6,
                        "total_grupos_con_datos": 3,
                    },
                    "horarios": [],
                },
            )

            eliminados = build_data.limpiar_datasets_antiguos(tmp_dir, "35")
            self.assertEqual(eliminados, 1)
            self.assertFalse((tmp_dir / "sem_33_carr_12.json").exists())

            ruta_idx = build_data.actualizar_indice(
                tmp_dir,
                semestre_activo={"semestre": "35", "etiqueta_semestre": "2027-1"},
            )
            indice = json.loads(ruta_idx.read_text(encoding="utf-8"))
            self.assertEqual(indice["total_datasets"], 2)
            self.assertEqual(
                [d["nombre_carrera"] for d in indice["datasets"]],
                ["ARQUITECTURA", "INGENIERIA EN COMPUTACION"],
            )

    def test_datasets_reales_cumplen_esquema_ultimo_semestre(self):
        ruta_index = DATA_DIR / "index.json"
        if not ruta_index.exists():
            self.skipTest("data/index.json aún no ha sido generado.")

        indice = json.loads(ruta_index.read_text(encoding="utf-8"))
        self.assertGreaterEqual(indice["total_datasets"], 1)
        sem_activo = str(indice.get("semestre_activo", {}).get("semestre", ""))

        campos_obligatorios = {
            "id",
            "clv_materia",
            "grupo",
            "semestre",
            "carrera",
            "materia",
            "profesor",
            "salon",
            "cupo",
            "tipo_clase",
            "bloques",
        }
        for ds in indice["datasets"]:
            if sem_activo:
                self.assertEqual(str(ds["semestre"]), sem_activo)
            ruta = DATA_DIR / ds["archivo"]
            self.assertTrue(ruta.exists(), f"Falta el archivo {ruta}")
            contenido = json.loads(ruta.read_text(encoding="utf-8"))
            self.assertIn("metadata", contenido)
            self.assertIn("horarios", contenido)
            self.assertGreater(len(contenido["horarios"]), 0)

            for reg in contenido["horarios"]:
                self.assertTrue(campos_obligatorios.issubset(reg.keys()))
                for campo_texto in ("materia", "profesor", "salon", "tipo_clase"):
                    valor = reg[campo_texto]
                    self.assertNotIn("Ã", valor, f"Posible mojibake en {reg['id']}: {valor}")
                    self.assertNotIn("&Ntilde;", valor)
                for bloque in reg["bloques"]:
                    self.assertIn(bloque["dia"], conexion.DIAS)
                    self.assertIn("hora_texto", bloque)
                    self.assertIn("inicio_min", bloque)
                    self.assertIn("fin_min", bloque)


if __name__ == "__main__":
    unittest.main()
