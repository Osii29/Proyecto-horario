"""Módulo ETL de extracción, limpieza y normalización de horarios.

Consume el endpoint de horarios (queysA.php), descubre grupos por carrera y
semestre (tipo=4), consulta horarios por grupo (tipo=2), decodifica y
normaliza textos/modalidades, parsea bloques diarios a minutos desde las 00:00
y registra incidencias en logs sin abortar el procesamiento del lote.
"""

import html
import logging
import re
import time
from typing import Any, Optional, Union

import requests

# Configuración del logger del módulo (el script orquestador configura handlers/niveles)
logger = logging.getLogger(__name__)

# Endpoint oficial de consulta de horarios (FES Aragón)
ENDPOINT_HORARIOS = (
    "https://www.aragon.unam.mx/horarios/horarios/index_archivos/php/queysA.php"
)

# Códigos de días esperados en la respuesta del endpoint
DIAS = ["LU", "MA", "MI", "JU", "VI", "SA"]

# Mapa de modalidades reportadas en el campo tipoclase
TIPOS_CLASE = {
    "P": "PRESENCIAL",
    "S": "SEMIPRESENCIAL",
    "A": "A DISTANCIA",
    "H": "HIBRIDO",
    "X": "SIN ESPECIFICAR",
    "": "SIN ESPECIFICAR",
}

# Expresión regular para validar horas con formato H:MM o HH:MM
PATRON_HORA = re.compile(r"^\d{1,2}:\d{2}$")

# Expresión regular para separar etiquetas <br>, <br/> y <br /> (insensible a mayúsculas)
PATRON_BR = re.compile(r"<br\s*/?>", flags=re.IGNORECASE)

# Secuencias cp1252 que suelen corresponder a mojibake UTF-8 dentro de cadenas mixtas
PATRON_MOJIBAKE = re.compile(r"(?:Ã[\x80-\xbf\u2018-\u203a\u0152-\u017e\u02c6\u02dc\u20ac\u2122\u0192]|Â[\x80-\xbf\u00a0-\u00bf])+")


def _registrar_incidencia(
    incidencias: Optional[list[dict[str, Any]]],
    tipo: str,
    contexto: str,
    detalle: str,
) -> None:
    """Agrega un registro estructurado de incidencia si la lista fue proporcionada."""
    if incidencias is not None:
        incidencias.append(
            {
                "tipo": tipo,
                "contexto": contexto or "sin contexto",
                "detalle": detalle,
            }
        )


def _corregir_mojibake_fragmentos(texto: str) -> str:
    """Intenta reparar secuencias mojibake aisladas cuando la cadena mezcla UTF-8 y cp1252."""

    def _reemplazar_token(match: re.Match[str]) -> str:
        fragmento = match.group(0)
        try:
            return fragmento.encode("cp1252").decode("utf-8")
        except UnicodeError:
            return fragmento

    # Primero intenta corregir por palabras completas para conservar contexto multi-byte
    palabras = texto.split(" ")
    corregidas: list[str] = []
    for palabra in palabras:
        try:
            corregidas.append(palabra.encode("cp1252").decode("utf-8"))
        except UnicodeError:
            corregidas.append(PATRON_MOJIBAKE.sub(_reemplazar_token, palabra))
    return " ".join(corregidas).strip()


def limpiar_texto(valor: Any) -> str:
    """Decodifica entidades HTML y corrige codificaciones mixtas cp1252/utf-8.

    Si el valor es nulo o vacío devuelve una cadena vacía. Ante errores de
    codificación, intenta reparar fragmentos mojibake y conserva el texto legible
    sin abortar el lote.
    """
    if valor is None:
        return ""

    texto = html.unescape(str(valor)).strip()
    if not texto:
        return ""

    try:
        # Corrige casos comunes de mojibake (bytes UTF-8 interpretados como cp1252)
        return texto.encode("cp1252").decode("utf-8").strip()
    except UnicodeError:
        # Si mezcla entidades HTML decodificadas (p. ej. Ñ) y mojibake (p. ej. Ã‘),
        # corrige por palabra/fragmento; si ya es UTF-8 puro, lo deja intacto.
        if "Ã" in texto or "Â" in texto:
            return _corregir_mojibake_fragmentos(texto)
        return texto


def normalizar_tipo_clase(
    valor: Any,
    contexto: str = "",
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> str:
    """Normaliza la clave de modalidad (`tipoclase`) a una etiqueta legible."""
    texto = limpiar_texto(valor).upper()

    if texto in TIPOS_CLASE:
        return TIPOS_CLASE[texto]

    if texto in TIPOS_CLASE.values():
        return texto

    etiqueta = contexto or "registro sin contexto"
    logger.warning("Tipo de clase desconocido (%r) en %s.", texto, etiqueta)
    _registrar_incidencia(
        incidencias,
        "tipo_clase_desconocido",
        etiqueta,
        f"Valor inesperado: {texto!r}",
    )
    return texto


def parsear_cupo(
    valor: Any,
    contexto: str = "",
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> Optional[int]:
    """Convierte el campo cupo a entero cuando es numérico; de lo contrario retorna None."""
    texto = limpiar_texto(valor)
    if not texto:
        return None

    try:
        return int(texto)
    except ValueError:
        etiqueta = contexto or "registro sin contexto"
        logger.warning("Cupo no numérico (%r) en %s.", texto, etiqueta)
        _registrar_incidencia(
            incidencias,
            "cupo_no_numerico",
            etiqueta,
            f"Valor recibido: {texto!r}",
        )
        return None


def hora_a_minutos(hhmm: str) -> Optional[int]:
    """Convierte una hora 'HH:MM' a minutos transcurridos desde las 00:00.

    Valida que la hora esté entre 0 y 23 y los minutos entre 0 y 59.
    Devuelve None si el formato o el rango son inválidos.
    """
    texto = hhmm.strip()
    if not PATRON_HORA.fullmatch(texto):
        return None

    horas_str, minutos_str = texto.split(":")
    horas, minutos = int(horas_str), int(minutos_str)

    if not (0 <= horas <= 23 and 0 <= minutos <= 59):
        return None

    return horas * 60 + minutos


def parsear_bloques(
    dia_codigo: str,
    raw_dia: Any,
    contexto: str = "",
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[dict[str, Any]]:
    """Parsea el campo crudo de un día en una lista de bloques horarios normalizados.

    Cada bloque contiene: dia, hora_texto, inicio_min y fin_min.
    Si se detectan horas inválidas, rangos invertidos o elementos impares,
    se registra una advertencia en logs y se conserva el bloque con minutos en None.
    """
    if not raw_dia:
        return []

    limpio = html.unescape(str(raw_dia))
    partes = [p.strip() for p in PATRON_BR.split(limpio) if p.strip()]
    bloques: list[dict[str, Any]] = []
    etiqueta = contexto or "registro sin contexto"

    # Empareja elementos consecutivos de dos en dos: [hora_inicio, hora_fin]
    for i in range(0, len(partes) - 1, 2):
        h_ini, h_fin = partes[i], partes[i + 1]
        inicio_min = hora_a_minutos(h_ini)
        fin_min = hora_a_minutos(h_fin)

        if inicio_min is not None and fin_min is not None and inicio_min < fin_min:
            bloques.append(
                {
                    "dia": dia_codigo,
                    "hora_texto": f"{h_ini}-{h_fin}",
                    "inicio_min": inicio_min,
                    "fin_min": fin_min,
                }
            )
        else:
            # Registra el caso irregular sin detener el procesamiento del lote (RF-DAT-05)
            logger.warning(
                "Bloque horario irregular en %s (%s): inicio=%r, fin=%r",
                etiqueta,
                dia_codigo,
                h_ini,
                h_fin,
            )
            _registrar_incidencia(
                incidencias,
                "bloque_irregular",
                f"{etiqueta} ({dia_codigo})",
                f"inicio={h_ini!r}, fin={h_fin!r}",
            )
            bloques.append(
                {
                    "dia": dia_codigo,
                    "hora_texto": f"{h_ini} -> {h_fin}",
                    "inicio_min": None,
                    "fin_min": None,
                }
            )

    # Caso atípico: sobra un elemento impar sin pareja
    if len(partes) % 2 != 0:
        sobrante = partes[-1]
        logger.warning(
            "Bloque horario impar en %s (%s): elemento sobrante=%r",
            etiqueta,
            dia_codigo,
            sobrante,
        )
        _registrar_incidencia(
            incidencias,
            "bloque_impar",
            f"{etiqueta} ({dia_codigo})",
            f"elemento_sobrante={sobrante!r}",
        )
        bloques.append(
            {
                "dia": dia_codigo,
                "hora_texto": sobrante,
                "inicio_min": None,
                "fin_min": None,
            }
        )

    return bloques


def formatear_horario(
    datos: Any,
    sem: Any = "",
    carr: Any = "",
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[dict[str, Any]]:
    """Normaliza la lista cruda devuelta por el endpoint al esquema JSON del proyecto.

    Parámetros:
        datos: Lista de diccionarios obtenida del JSON del portal.
        sem: Identificador de semestre consultado.
        carr: Identificador de carrera consultada.
        incidencias: Lista opcional para acumular casos irregulares detectados.
    """
    if not isinstance(datos, list):
        contexto_resp = f"sem={sem} carr={carr}"
        logger.warning(
            "Se esperaba una lista de registros para %s, se recibió %s.",
            contexto_resp,
            type(datos).__name__,
        )
        _registrar_incidencia(
            incidencias,
            "respuesta_no_lista",
            contexto_resp,
            f"Tipo recibido: {type(datos).__name__}",
        )
        return []

    resultado: list[dict[str, Any]] = []

    for indice, item in enumerate(datos):
        if not isinstance(item, dict):
            contexto_item = f"sem={sem} carr={carr} indice={indice}"
            logger.warning(
                "Registro #%d omitido en sem=%s carr=%s: no es un objeto válido (%s).",
                indice,
                sem,
                carr,
                type(item).__name__,
            )
            _registrar_incidencia(
                incidencias,
                "registro_no_objeto",
                contexto_item,
                f"Tipo recibido: {type(item).__name__}",
            )
            continue

        clv_materia = limpiar_texto(item.get("clv_materia"))
        grupo = limpiar_texto(item.get("grupo"))
        contexto = (
            f"sem={sem} carr={carr} materia={clv_materia or '?'} grupo={grupo or '?'}"
        )

        # Extrae y concatena los bloques horarios de lunes a sábado
        bloques: list[dict[str, Any]] = []
        for dia in DIAS:
            bloques.extend(
                parsear_bloques(
                    dia,
                    item.get(dia),
                    contexto=contexto,
                    incidencias=incidencias,
                )
            )

        if not bloques:
            logger.info("Registro sin bloques horarios asignados: %s", contexto)
            _registrar_incidencia(
                incidencias,
                "sin_bloques_horarios",
                contexto,
                "La asignatura no tiene horas registradas de LU a SA.",
            )

        resultado.append(
            {
                "clv_materia": clv_materia,
                "grupo": grupo,
                "semestre": str(sem),
                "carrera": str(carr),
                "materia": limpiar_texto(item.get("nomb_cmateria")),
                "profesor": limpiar_texto(item.get("nomb_prof")),
                "salon": limpiar_texto(item.get("clv_salon")),
                "cupo": parsear_cupo(
                    item.get("cupo"), contexto=contexto, incidencias=incidencias
                ),
                "tipo_clase": normalizar_tipo_clase(
                    item.get("tipoclase"),
                    contexto=contexto,
                    incidencias=incidencias,
                ),
                "bloques": bloques,
            }
        )

    return resultado


def _consultar_json(
    payload: dict[str, Any],
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
) -> Any:
    """Realiza una consulta GET al endpoint con reintentos ante fallos transitorios."""
    cliente = session or requests
    total_intentos = max(1, reintentos + 1)

    for intento in range(total_intentos):
        try:
            respuesta = cliente.get(
                ENDPOINT_HORARIOS,
                params=payload,
                timeout=timeout,
                headers={"User-Agent": "ProyectoHorarios-ETL/1.0"},
            )
            respuesta.raise_for_status()
            break
        except requests.RequestException as exc:
            resp = getattr(exc, "response", None)
            es_error_cliente_definitivo = (
                resp is not None
                and 400 <= resp.status_code < 500
                and resp.status_code not in (408, 429)
            )
            if es_error_cliente_definitivo or intento >= total_intentos - 1:
                logger.error("Error HTTP/red al consultar %s: %s", payload, exc)
                raise

            espera = 0.5 * (2**intento)
            logger.warning(
                "Fallo transitorio al consultar %s (%s). Reintentando en %.1fs (%d/%d)...",
                payload,
                exc,
                espera,
                intento + 1,
                reintentos,
            )
            time.sleep(espera)

    # Fuerza UTF-8 si el servidor no especifica codificación adecuada
    respuesta.encoding = "utf-8"

    try:
        return respuesta.json()
    except ValueError as exc:
        logger.error("La respuesta para %s no es un JSON válido: %s", payload, exc)
        raise


def _clave_orden_numerico(valor: str) -> tuple[int, Union[int, str]]:
    """Permite ordenar identificadores numéricos antes de valores alfabéticos."""
    return (0, int(valor)) if valor.isdigit() else (1, valor)


def obtener_semestres(
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[dict[str, str]]:
    """Obtiene el catálogo de semestres disponibles en el portal (tipo=0)."""
    payload = {"tipo": 0}
    datos_crudos = _consultar_json(
        payload, session=session, timeout=timeout, reintentos=reintentos
    )

    contexto = "tipo=0 semestres"
    if not isinstance(datos_crudos, list):
        logger.warning(
            "Se esperaba una lista de semestres en %s, se recibió %s.",
            contexto,
            type(datos_crudos).__name__,
        )
        _registrar_incidencia(
            incidencias,
            "semestres_respuesta_invalida",
            contexto,
            f"Tipo recibido: {type(datos_crudos).__name__}",
        )
        return []

    semestres: list[dict[str, str]] = []
    vistos: set[str] = set()

    for indice, entrada in enumerate(datos_crudos):
        if not isinstance(entrada, dict):
            logger.warning(
                "Entrada de semestre #%d inválida en %s: %r", indice, contexto, entrada
            )
            _registrar_incidencia(
                incidencias,
                "semestre_invalido",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        id_semestre = limpiar_texto(entrada.get("id_semestre"))
        nombre = limpiar_texto(entrada.get("nombre"))
        if not id_semestre:
            logger.warning(
                "Entrada de semestre #%d sin id_semestre en %s: %r",
                indice,
                contexto,
                entrada,
            )
            _registrar_incidencia(
                incidencias,
                "semestre_vacio",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        if id_semestre not in vistos:
            vistos.add(id_semestre)
            semestres.append(
                {
                    "id_semestre": id_semestre,
                    "nombre": nombre or id_semestre,
                }
            )

    semestres.sort(key=lambda s: _clave_orden_numerico(s["id_semestre"]))
    return semestres


def obtener_ultimo_semestre(
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> dict[str, str]:
    """Devuelve el semestre más reciente disponible según el mayor `id_semestre`."""
    semestres = obtener_semestres(
        session=session,
        timeout=timeout,
        reintentos=reintentos,
        incidencias=incidencias,
    )
    if not semestres:
        raise ValueError("No se encontraron semestres disponibles en el endpoint (tipo=0).")
    return semestres[-1]


def obtener_carreras(
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[dict[str, str]]:
    """Obtiene el catálogo completo de carreras disponibles en el portal (tipo=1)."""
    payload = {"tipo": 1}
    datos_crudos = _consultar_json(
        payload, session=session, timeout=timeout, reintentos=reintentos
    )

    contexto = "tipo=1 carreras"
    if not isinstance(datos_crudos, list):
        logger.warning(
            "Se esperaba una lista de carreras en %s, se recibió %s.",
            contexto,
            type(datos_crudos).__name__,
        )
        _registrar_incidencia(
            incidencias,
            "carreras_respuesta_invalida",
            contexto,
            f"Tipo recibido: {type(datos_crudos).__name__}",
        )
        return []

    carreras: list[dict[str, str]] = []
    vistas: set[str] = set()

    for indice, entrada in enumerate(datos_crudos):
        if not isinstance(entrada, dict):
            logger.warning(
                "Entrada de carrera #%d inválida en %s: %r", indice, contexto, entrada
            )
            _registrar_incidencia(
                incidencias,
                "carrera_invalida",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        id_area = limpiar_texto(entrada.get("id_area"))
        nombre = limpiar_texto(entrada.get("nombre"))
        if not id_area:
            logger.warning(
                "Entrada de carrera #%d sin id_area en %s: %r",
                indice,
                contexto,
                entrada,
            )
            _registrar_incidencia(
                incidencias,
                "carrera_vacia",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        if id_area not in vistas:
            vistas.add(id_area)
            carreras.append(
                {
                    "id_area": id_area,
                    "nombre": nombre or f"CARRERA {id_area}",
                }
            )

    carreras.sort(key=lambda c: c["nombre"])
    return carreras


def obtener_grupos(
    sem: Union[int, str],
    carr: Union[int, str],
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[str]:
    """Obtiene la lista completa de grupos existentes para un semestre y carrera (tipo=4)."""
    payload = {"tipo": 4, "sem": sem, "carr": carr}
    datos_crudos = _consultar_json(
        payload, session=session, timeout=timeout, reintentos=reintentos
    )

    contexto = f"sem={sem} carr={carr} tipo=4"
    if not isinstance(datos_crudos, list):
        logger.warning(
            "Se esperaba una lista de grupos en %s, se recibió %s.",
            contexto,
            type(datos_crudos).__name__,
        )
        _registrar_incidencia(
            incidencias,
            "grupos_respuesta_invalida",
            contexto,
            f"Tipo recibido: {type(datos_crudos).__name__}",
        )
        return []

    grupos: list[str] = []
    vistos: set[str] = set()

    for indice, entrada in enumerate(datos_crudos):
        if isinstance(entrada, dict):
            valor_grupo = entrada.get("grupo")
        elif isinstance(entrada, (str, int)):
            valor_grupo = entrada
        else:
            logger.warning(
                "Entrada de grupo #%d inválida en %s: %r", indice, contexto, entrada
            )
            _registrar_incidencia(
                incidencias,
                "grupo_invalido",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        grupo_limpio = limpiar_texto(valor_grupo)
        if not grupo_limpio:
            logger.warning(
                "Entrada de grupo #%d vacía en %s: %r", indice, contexto, entrada
            )
            _registrar_incidencia(
                incidencias,
                "grupo_vacio",
                contexto,
                f"Entrada #{indice}: {entrada!r}",
            )
            continue

        if grupo_limpio not in vistos:
            vistos.add(grupo_limpio)
            grupos.append(grupo_limpio)

    return grupos


def obtener_horario(
    tipo: int = 2,
    sem: Union[int, str] = "",
    carr: Union[int, str] = "",
    grupo: Union[int, str] = "",
    session: Optional[requests.Session] = None,
    timeout: int = 15,
    reintentos: int = 2,
    incidencias: Optional[list[dict[str, Any]]] = None,
) -> list[dict[str, Any]]:
    """Consulta el endpoint para un grupo específico y devuelve los registros normalizados.

    Parámetros:
        tipo: Tipo de consulta requerido por el endpoint (por defecto 2).
        sem: Clave de semestre.
        carr: Clave de carrera.
        grupo: Número o clave de grupo a consultar.
        session: Sesión opcional de requests para reutilizar conexiones TCP en lotes.
        timeout: Tiempo máximo de espera en segundos para la petición HTTP.
        reintentos: Número de reintentos ante fallos transitorios de red o servidor.
        incidencias: Lista opcional para acumular casos irregulares detectados.

    Lanza:
        requests.RequestException: Si ocurre un error de red, timeout o estatus HTTP erróneo.
        ValueError: Si la respuesta del servidor no es un JSON válido.
    """
    payload = {"tipo": tipo, "sem": sem, "carr": carr, "grupo": grupo}
    datos_crudos = _consultar_json(
        payload, session=session, timeout=timeout, reintentos=reintentos
    )
    return formatear_horario(datos_crudos, sem=sem, carr=carr, incidencias=incidencias)


if __name__ == "__main__":
    # Bloque de prueba manual: solo se ejecuta al correr este archivo directamente,
    # nunca cuando build_data.py importe funciones de este módulo.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    try:
        grupos = obtener_grupos(sem=35, carr=12)
        logger.info("Grupos encontrados para sem=35 carr=12: %d", len(grupos))
        if grupos:
            horario_normalizado = obtener_horario(
                tipo=2, sem=35, carr=12, grupo=grupos[0]
            )
            logger.info(
                "Registros normalizados en grupo %s: %d",
                grupos[0],
                len(horario_normalizado),
            )
    except (requests.RequestException, ValueError):
        logger.error("No fue posible completar la consulta de prueba.")
