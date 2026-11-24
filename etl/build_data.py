"""Script orquestador ETL para generar los archivos JSON estáticos del proyecto.

Por defecto detecta automáticamente el último semestre publicado (tipo=0) y
todas las carreras disponibles en el portal (tipo=1), descubre sus grupos
mediante tipo=4, consulta horarios mediante tipo=2 respetando pausas entre
peticiones (RNF-DAT-01), deduplica/asigna identificadores deterministas, limpia
datasets de semestres anteriores y actualiza el catálogo data/index.json.
"""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import time
from typing import Any, Optional, Union

import requests

try:
    from etl.conexion import (
        obtener_carreras,
        obtener_grupos,
        obtener_horario,
        obtener_ultimo_semestre,
    )
except ImportError:  # Permite ejecución directa como `python etl/build_data.py`
    from conexion import (
        obtener_carreras,
        obtener_grupos,
        obtener_horario,
        obtener_ultimo_semestre,
    )

logger = logging.getLogger(__name__)

# Directorio raíz del proyecto y carpeta destino de datos estáticos
ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"

# Respaldo estático cuando se parsean objetivos explícitos sin etiquetas completas
OBJETIVOS_POR_DEFECTO: list[dict[str, Any]] = [
    {
        "sem": 35,
        "carr": 12,
        "etiqueta_semestre": "2027-1",
        "nombre_carrera": "INGENIERIA EN COMPUTACION",
    }
]


def construir_clave_exacta(registro: dict[str, Any]) -> tuple[Any, ...]:
    """Construye una huella canónica para detectar registros idénticos duplicados."""
    bloques_canonicos = tuple(
        (
            bloque.get("dia"),
            bloque.get("hora_texto"),
            bloque.get("inicio_min"),
            bloque.get("fin_min"),
        )
        for bloque in registro.get("bloques", [])
    )
    return (
        registro.get("semestre", ""),
        registro.get("carrera", ""),
        registro.get("clv_materia", ""),
        registro.get("grupo", ""),
        registro.get("materia", ""),
        registro.get("profesor", ""),
        registro.get("salon", ""),
        registro.get("cupo"),
        registro.get("tipo_clase", ""),
        bloques_canonicos,
    )


def asignar_ids_y_deduplicar(
    registros: list[dict[str, Any]],
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> tuple[list[dict[str, Any]], int]:
    """Elimina duplicados exactos y asigna un `id` único y determinista a cada registro.

    Si la misma combinación `(clv_materia, grupo)` aparece con datos distintos
    (por ejemplo diferente profesor, salón o bloques), se conservan ambos con
    sufijo `_2`, `_3`, etc. y se reporta en logs e incidencias.
    """
    huellas_vistas: set[tuple[Any, ...]] = set()
    conteo_ids_base: dict[str, int] = {}
    limpios: list[dict[str, Any]] = []
    duplicados_omitidos = 0

    for registro in registros:
        huella = construir_clave_exacta(registro)
        if huella in huellas_vistas:
            duplicados_omitidos += 1
            continue
        huellas_vistas.add(huella)

        semestre = str(registro.get("semestre", "")).strip() or "0"
        carrera = str(registro.get("carrera", "")).strip() or "0"
        clv_materia = str(registro.get("clv_materia", "")).strip() or "SIN_CLAVE"
        grupo = str(registro.get("grupo", "")).strip() or "SIN_GRUPO"

        id_base = f"{semestre}_{carrera}_{clv_materia}_{grupo}"
        ocurrencia = conteo_ids_base.get(id_base, 0) + 1
        conteo_ids_base[id_base] = ocurrencia

        if ocurrencia == 1:
            id_final = id_base
        else:
            id_final = f"{id_base}_{ocurrencia}"
            mensaje = (
                f"Múltiples registros distintos para {id_base}; "
                f"conservado como {id_final} ({registro.get('materia', '')})."
            )
            logger.warning(mensaje)
            if incidencias is not None:
                incidencias.append(
                    {
                        "tipo": "registro_duplicado_distinto",
                        "contexto": f"sem={semestre} carr={carrera} materia={clv_materia} grupo={grupo}",
                        "detalle": mensaje,
                    }
                )

        registro_con_id = {"id": id_final, **registro}
        limpios.append(registro_con_id)

    return limpios, duplicados_omitidos


def descubrir_objetivos_ultimo_semestre(
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    filtro_carreras: Optional[set[str]] = None,
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    """Descubre el semestre más reciente y construye objetivos para todas sus carreras."""
    ultimo_semestre = obtener_ultimo_semestre(
        session=session,
        timeout=timeout,
        reintentos=reintentos,
    )
    carreras = obtener_carreras(
        session=session,
        timeout=timeout,
        reintentos=reintentos,
    )

    sem_id = ultimo_semestre["id_semestre"]
    etiqueta_semestre = ultimo_semestre["nombre"]

    objetivos: list[dict[str, Any]] = []
    for carr in carreras:
        carr_id = carr["id_area"]
        if filtro_carreras and carr_id not in filtro_carreras:
            continue
        objetivos.append(
            {
                "sem": sem_id,
                "carr": carr_id,
                "etiqueta_semestre": etiqueta_semestre,
                "nombre_carrera": carr["nombre"],
            }
        )

    return ultimo_semestre, objetivos


def extraer_objetivo(
    sem: Union[int, str],
    carr: Union[int, str],
    session: Optional[requests.Session] = None,
    pausa: float = 0.15,
    timeout: int = 15,
    reintentos: int = 2,
    etiqueta_semestre: str = "",
    nombre_carrera: str = "",
) -> dict[str, Any]:
    """Extrae y normaliza todos los horarios de una combinación semestre/carrera."""
    incidencias: list[dict[str, Any]] = []
    grupos = obtener_grupos(
        sem=sem,
        carr=carr,
        session=session,
        timeout=timeout,
        reintentos=reintentos,
        incidencias=incidencias,
    )

    logger.info(
        "Iniciando extracción para sem=%s (%s) carr=%s (%s): %d grupos encontrados.",
        sem,
        etiqueta_semestre or "-",
        carr,
        nombre_carrera or "-",
        len(grupos),
    )

    registros_crudos: list[dict[str, Any]] = []
    grupos_con_datos = 0
    grupos_vacios = 0
    grupos_fallidos: list[str] = []

    for indice, grupo in enumerate(grupos):
        try:
            registros_grupo = obtener_horario(
                tipo=2,
                sem=sem,
                carr=carr,
                grupo=grupo,
                session=session,
                timeout=timeout,
                reintentos=reintentos,
                incidencias=incidencias,
            )
        except (requests.RequestException, ValueError) as exc:
            logger.error(
                "No se pudo obtener el grupo %s (sem=%s, carr=%s): %s. Continúa el lote.",
                grupo,
                sem,
                carr,
                exc,
            )
            grupos_fallidos.append(str(grupo))
            incidencias.append(
                {
                    "tipo": "grupo_error_http_o_json",
                    "contexto": f"sem={sem} carr={carr} grupo={grupo}",
                    "detalle": str(exc),
                }
            )
        else:
            if registros_grupo:
                grupos_con_datos += 1
                registros_crudos.extend(registros_grupo)
            else:
                grupos_vacios += 1
                logger.info(
                    "Grupo %s sin materias registradas (sem=%s carr=%s).",
                    grupo,
                    sem,
                    carr,
                )

        # Pausa entre peticiones para no saturar el servidor origen (RNF-DAT-01)
        if pausa > 0 and indice < len(grupos) - 1:
            time.sleep(pausa)

    registros_finales, duplicados_omitidos = asignar_ids_y_deduplicar(
        registros_crudos, incidencias=incidencias
    )

    # Orden determinista por clave de materia, grupo e id
    registros_finales.sort(
        key=lambda r: (
            str(r.get("clv_materia", "")),
            str(r.get("grupo", "")),
            str(r.get("id", "")),
        )
    )

    materias_unicas = {
        r.get("clv_materia") or r.get("materia")
        for r in registros_finales
        if r.get("clv_materia") or r.get("materia")
    }

    conteo_incidencias = dict(Counter(inc["tipo"] for inc in incidencias))
    generado_en = datetime.now(timezone.utc).isoformat()

    return {
        "metadata": {
            "semestre": str(sem),
            "etiqueta_semestre": etiqueta_semestre,
            "carrera": str(carr),
            "nombre_carrera": nombre_carrera,
            "generado_en": generado_en,
            "total_grupos_consultados": len(grupos),
            "total_grupos_con_datos": grupos_con_datos,
            "total_grupos_vacios": grupos_vacios,
            "total_grupos_con_error": len(grupos_fallidos),
            "grupos_fallidos": grupos_fallidos,
            "total_registros": len(registros_finales),
            "total_materias_unicas": len(materias_unicas),
            "duplicados_omitidos": duplicados_omitidos,
            "total_incidencias": len(incidencias),
        },
        "resumen_incidencias": {
            "total": len(incidencias),
            "por_tipo": conteo_incidencias,
            "muestra": incidencias[:25],
        },
        "horarios": registros_finales,
    }


def guardar_json(ruta: Path, contenido: dict[str, Any]) -> Path:
    """Guarda un diccionario como archivo JSON UTF-8 legible."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with ruta.open("w", encoding="utf-8") as archivo:
        json.dump(contenido, archivo, ensure_ascii=False, indent=2)
    return ruta


def limpiar_datasets_antiguos(dir_salida: Path, semestre_activo: Union[int, str]) -> int:
    """Elimina archivos `sem_*_carr_*.json` que no pertenezcan al semestre activo."""
    sem_str = str(semestre_activo).strip()
    if not sem_str or not dir_salida.exists():
        return 0

    eliminados = 0
    prefijo_activo = f"sem_{sem_str}_carr_"
    for archivo in dir_salida.glob("sem_*_carr_*.json"):
        if not archivo.name.startswith(prefijo_activo):
            try:
                archivo.unlink()
                eliminados += 1
                logger.info("Dataset de semestre anterior eliminado: %s", archivo.name)
            except OSError as exc:
                logger.warning("No se pudo eliminar %s: %s", archivo.name, exc)
    return eliminados


def _clave_orden_dataset(item: dict[str, Any]) -> tuple[int, str, str, str]:
    """Ordena por semestre más reciente primero y alfabéticamente por carrera."""
    sem_str = str(item.get("semestre", "0"))
    sem_num = int(sem_str) if sem_str.isdigit() else -1
    return (
        -sem_num,
        str(item.get("nombre_carrera", "")),
        str(item.get("carrera", "")),
        str(item.get("archivo", "")),
    )


def actualizar_indice(
    dir_salida: Path,
    semestre_activo: Optional[dict[str, str]] = None,
) -> Path:
    """Genera/actualiza `data/index.json` con los datasets válidos disponibles."""
    dir_salida.mkdir(parents=True, exist_ok=True)
    datasets: list[dict[str, Any]] = []
    sem_filtro = (
        str(semestre_activo.get("semestre", "")).strip()
        if isinstance(semestre_activo, dict)
        else ""
    )

    for archivo in sorted(dir_salida.glob("sem_*_carr_*.json")):
        try:
            with archivo.open("r", encoding="utf-8") as f:
                contenido = json.load(f)
        except (OSError, ValueError) as exc:
            logger.warning("No se pudo leer %s para el índice: %s", archivo.name, exc)
            continue

        if not isinstance(contenido, dict) or "metadata" not in contenido:
            continue

        meta = contenido["metadata"]
        sem_item = str(meta.get("semestre", ""))
        total_reg = int(meta.get("total_registros") or 0)

        if total_reg <= 0:
            continue
        if sem_filtro and sem_item != sem_filtro:
            continue

        datasets.append(
            {
                "archivo": archivo.name,
                "semestre": sem_item,
                "etiqueta_semestre": meta.get("etiqueta_semestre", ""),
                "carrera": str(meta.get("carrera", "")),
                "nombre_carrera": meta.get("nombre_carrera", ""),
                "generado_en": meta.get("generado_en", ""),
                "total_registros": total_reg,
                "total_materias_unicas": meta.get("total_materias_unicas", 0),
                "total_grupos_con_datos": meta.get("total_grupos_con_datos", 0),
            }
        )

    datasets.sort(key=_clave_orden_dataset)

    semestre_meta = semestre_activo
    if not semestre_meta and datasets:
        semestre_meta = {
            "semestre": datasets[0]["semestre"],
            "etiqueta_semestre": datasets[0]["etiqueta_semestre"],
        }

    indice = {
        "generado_en": datetime.now(timezone.utc).isoformat(),
        "semestre_activo": semestre_meta,
        "total_datasets": len(datasets),
        "datasets": datasets,
    }
    return guardar_json(dir_salida / "index.json", indice)


def parsear_objetivos_cli(valores: Optional[list[str]]) -> Optional[list[dict[str, Any]]]:
    """Convierte argumentos `sem:carr[:etiqueta[:carrera]]` en lista de objetivos."""
    if not valores:
        return None

    objetivos: list[dict[str, Any]] = []
    for valor in valores:
        partes = [p.strip() for p in valor.split(":")]
        if len(partes) < 2 or not partes[0] or not partes[1]:
            raise ValueError(
                f"Objetivo inválido {valor!r}. Usa el formato sem:carr (ejemplo: 35:12)."
            )
        sem = int(partes[0]) if partes[0].isdigit() else partes[0]
        carr = int(partes[1]) if partes[1].isdigit() else partes[1]

        base = next(
            (
                o
                for o in OBJETIVOS_POR_DEFECTO
                if str(o["sem"]) == str(sem) and str(o["carr"]) == str(carr)
            ),
            {},
        )
        objetivos.append(
            {
                "sem": sem,
                "carr": carr,
                "etiqueta_semestre": partes[2]
                if len(partes) >= 3 and partes[2]
                else base.get("etiqueta_semestre", ""),
                "nombre_carrera": partes[3]
                if len(partes) >= 4 and partes[3]
                else base.get("nombre_carrera", ""),
            }
        )
    return objetivos


def _cargar_existente_valido(
    ruta: Path, sem: Union[int, str], carr: Union[int, str]
) -> Optional[dict[str, Any]]:
    """Devuelve metadata existente si el JSON ya fue generado y contiene registros."""
    if not ruta.exists():
        return None
    try:
        contenido = json.loads(ruta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    meta = contenido.get("metadata") if isinstance(contenido, dict) else None
    if not isinstance(meta, dict):
        return None
    if (
        str(meta.get("semestre", "")) == str(sem)
        and str(meta.get("carrera", "")) == str(carr)
        and int(meta.get("total_registros") or 0) > 0
    ):
        return meta
    return None


def ejecutar_lote(
    objetivos: Optional[list[dict[str, Any]]] = None,
    dir_salida: Path = DATA_DIR,
    pausa: float = 0.15,
    timeout: int = 15,
    reintentos: int = 2,
    filtro_carreras: Optional[set[str]] = None,
    omitir_existentes: bool = False,
    limpiar_antiguos: Optional[bool] = None,
) -> list[dict[str, Any]]:
    """Ejecuta la extracción por lotes.

    Si `objetivos` es None, descubre el último semestre disponible en el portal
    y extrae todas las carreras activas de ese semestre, limpiando datasets de
    semestres anteriores salvo que `limpiar_antiguos` sea False.
    """
    resumenes: list[dict[str, Any]] = []
    semestre_activo: Optional[dict[str, str]] = None
    modo_automatico = objetivos is None

    with requests.Session() as session:
        if modo_automatico:
            try:
                ultimo_sem, lista_objetivos = descubrir_objetivos_ultimo_semestre(
                    session=session,
                    timeout=timeout,
                    reintentos=reintentos,
                    filtro_carreras=filtro_carreras,
                )
            except (requests.RequestException, ValueError) as exc:
                logger.error("No fue posible descubrir el último semestre/carreras: %s", exc)
                return []

            semestre_activo = {
                "semestre": str(ultimo_sem["id_semestre"]),
                "etiqueta_semestre": str(ultimo_sem["nombre"]),
            }
            logger.info(
                "Semestre más reciente detectado: %s (%s) con %d carreras a evaluar.",
                semestre_activo["etiqueta_semestre"],
                semestre_activo["semestre"],
                len(lista_objetivos),
            )
        else:
            lista_objetivos = objetivos

        debe_limpiar = modo_automatico if limpiar_antiguos is None else limpiar_antiguos
        if debe_limpiar and semestre_activo:
            limpiar_datasets_antiguos(dir_salida, semestre_activo["semestre"])

        for idx, obj in enumerate(lista_objetivos):
            sem = obj["sem"]
            carr = obj["carr"]
            ruta_salida = dir_salida / f"sem_{sem}_carr_{carr}.json"

            if omitir_existentes:
                meta_existente = _cargar_existente_valido(ruta_salida, sem, carr)
                if meta_existente:
                    logger.info(
                        "Archivo existente reutilizado: %s (%d registros).",
                        ruta_salida.name,
                        meta_existente["total_registros"],
                    )
                    resumenes.append({"archivo": str(ruta_salida), **meta_existente})
                    continue

            try:
                resultado = extraer_objetivo(
                    sem=sem,
                    carr=carr,
                    session=session,
                    pausa=pausa,
                    timeout=timeout,
                    reintentos=reintentos,
                    etiqueta_semestre=obj.get("etiqueta_semestre", ""),
                    nombre_carrera=obj.get("nombre_carrera", ""),
                )
            except (requests.RequestException, ValueError) as exc:
                logger.error(
                    "Falló el descubrimiento de grupos para sem=%s carr=%s: %s",
                    sem,
                    carr,
                    exc,
                )
                continue

            meta = resultado["metadata"]
            if meta["total_registros"] == 0:
                logger.info(
                    "Carrera omitida sin horarios activos: sem=%s carr=%s (%s).",
                    sem,
                    carr,
                    obj.get("nombre_carrera", ""),
                )
                if ruta_salida.exists():
                    ruta_salida.unlink(missing_ok=True)
                continue

            guardar_json(ruta_salida, resultado)
            resumenes.append({"archivo": str(ruta_salida), **meta})

            logger.info(
                "Archivo generado: %s | registros=%d | materias=%d | grupos_ok=%d/%d | errores=%d | incidencias=%d",
                ruta_salida.name,
                meta["total_registros"],
                meta["total_materias_unicas"],
                meta["total_grupos_con_datos"],
                meta["total_grupos_consultados"],
                meta["total_grupos_con_error"],
                meta["total_incidencias"],
            )

            if pausa > 0 and idx < len(lista_objetivos) - 1:
                time.sleep(pausa)

    ruta_indice = actualizar_indice(dir_salida, semestre_activo=semestre_activo)
    logger.info("Índice actualizado: %s", ruta_indice)
    return resumenes


def _configurar_logging(log_archivo: Optional[str] = None) -> None:
    """Configura logging en consola y opcionalmente hacia un archivo."""
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_archivo:
        ruta_log = Path(log_archivo)
        ruta_log.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(ruta_log, encoding="utf-8"))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )


def main(argv: Optional[list[str]] = None) -> int:
    """Punto de entrada CLI para generar los datos estáticos del proyecto."""
    parser = argparse.ArgumentParser(
        description=(
            "Genera archivos JSON de horarios del último semestre disponible "
            "para todas las carreras activas."
        )
    )
    parser.add_argument(
        "--objetivos",
        nargs="+",
        help="Opcional: lista explícita en formato sem:carr (ej. 35:12).",
    )
    parser.add_argument(
        "--carreras",
        nargs="+",
        help="Opcional: filtrar claves de carrera (id_area) del último semestre.",
    )
    parser.add_argument(
        "--omitir-existentes",
        action="store_true",
        help="Reutiliza archivos JSON ya existentes y válidos del semestre activo.",
    )
    parser.add_argument(
        "--conservar-antiguos",
        action="store_true",
        help="Conserva archivos JSON de semestres anteriores en data/.",
    )
    parser.add_argument(
        "--pausa",
        type=float,
        default=0.15,
        help="Segundos de espera entre peticiones HTTP (por defecto: 0.15).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=15,
        help="Timeout HTTP en segundos por petición (por defecto: 15).",
    )
    parser.add_argument(
        "--reintentos",
        type=int,
        default=2,
        help="Número de reintentos ante errores transitorios (por defecto: 2).",
    )
    parser.add_argument(
        "--salida",
        type=Path,
        default=DATA_DIR,
        help=f"Carpeta destino para los JSON (por defecto: {DATA_DIR}).",
    )
    parser.add_argument(
        "--log-archivo",
        type=str,
        default=None,
        help="Ruta opcional para guardar la bitácora completa del lote.",
    )

    args = parser.parse_args(argv)
    _configurar_logging(args.log_archivo)

    try:
        objetivos = parsear_objetivos_cli(args.objetivos)
    except ValueError as exc:
        logger.error("%s", exc)
        return 2

    filtro_carreras = {str(c).strip() for c in args.carreras} if args.carreras else None
    limpiar_antiguos = False if args.conservar_antiguos else None

    resumenes = ejecutar_lote(
        objetivos=objetivos,
        dir_salida=args.salida,
        pausa=max(0.0, args.pausa),
        timeout=max(1, args.timeout),
        reintentos=max(0, args.reintentos),
        filtro_carreras=filtro_carreras,
        omitir_existentes=args.omitir_existentes,
        limpiar_antiguos=limpiar_antiguos,
    )

    if not resumenes:
        logger.error("No se pudo generar ningún dataset en este lote.")
        return 1

    logger.info("Lote completado exitosamente (%d datasets generados).", len(resumenes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
