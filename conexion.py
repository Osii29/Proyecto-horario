import html
import re
import requests

DIAS = ["LU", "MA", "MI", "JU", "VI", "SA"]


def limpiar_texto(valor):
    if not valor:
        return ""
    texto = html.unescape(str(valor)).strip()
    try:
        return texto.encode("cp1252").decode("utf-8").strip()
    except UnicodeError:
        return texto


def hora_a_minutos(hhmm):
    partes = hhmm.strip().split(":")
    return int(partes[0]) * 60 + int(partes[1])


def parsear_bloques(dia_codigo, raw_dia):
    if not raw_dia:
        return []

    limpio = html.unescape(str(raw_dia))
    partes = [p.strip() for p in re.split(r"<br\s*/?>", limpio, flags=re.IGNORECASE) if p.strip()]
    bloques = []

    # Agrupa de dos en dos: [hora_inicio, hora_fin]
    for i in range(0, len(partes) - 1, 2):
        h_ini, h_fin = partes[i], partes[i + 1]
        if re.fullmatch(r"\d{1,2}:\d{2}", h_ini) and re.fullmatch(r"\d{1,2}:\d{2}", h_fin):
            bloques.append({
                "dia": dia_codigo,
                "hora_texto": f"{h_ini}-{h_fin}",
                "inicio_min": hora_a_minutos(h_ini),
                "fin_min": hora_a_minutos(h_fin),
            })
        else:
            bloques.append({
                "dia": dia_codigo,
                "hora_texto": f"{h_ini} -> {h_fin}",
                "inicio_min": None,
                "fin_min": None,
            })

    # Si sobra un elemento impar (caso atípico)
    if len(partes) % 2 != 0:
        bloques.append({
            "dia": dia_codigo,
            "hora_texto": partes[-1],
            "inicio_min": None,
            "fin_min": None,
        })

    return bloques


def formatear_horario(datos, sem="", carr=""):
    resultado = []
    for item in datos:
        bloques = []
        for dia in DIAS:
            bloques.extend(parsear_bloques(dia, item.get(dia)))

        resultado.append({
            "clv_materia": limpiar_texto(item.get("clv_materia")),
            "grupo": limpiar_texto(item.get("grupo")),
            "semestre": str(sem),
            "carrera": str(carr),
            "materia": limpiar_texto(item.get("nomb_cmateria")),
            "profesor": limpiar_texto(item.get("nomb_prof")),
            "salon": limpiar_texto(item.get("clv_salon")),
            "cupo": limpiar_texto(item.get("cupo")),
            "tipo_clase": limpiar_texto(item.get("tipoclase")),
            "bloques": bloques,
        })
    return resultado

payload = {"tipo": 2, "sem": 33, "carr": 12, "grupo": 1558}
r = requests.get(
    "https://www.aragon.unam.mx/horarios/horarios/index_archivos/php/queysA.php",
    params=payload,
    timeout=15,
)
r.raise_for_status()
r.encoding = "utf-8"
horario_normalizado = formatear_horario(r.json(), payload)
print(horario_normalizado)