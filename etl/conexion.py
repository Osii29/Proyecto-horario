# Módulo de extracción, limpieza y normalización de horarios (ETL).
# Debe contener:
# - Consumo del endpoint de horarios (queysA.php) con parámetros configurables (tipo, sem, carr, grupo), manejo de timeouts, errores HTTP y límites de frecuencia (RF-DAT-01, RNF-DAT-01).
# - Decodificación de entidades HTML y normalización segura de codificaciones mixtas cp1252 / utf-8 (RF-DAT-02).
# - Parseo de campos diarios (LU, MA, MI, JU, VI, SA) separados por <br /> / <br> / <br/> a bloques { dia, hora_texto, inicio_min, fin_min } en minutos desde las 00:00 (RF-DAT-03).
# - Normalización de cada registro con clv_materia, grupo, semestre, carrera, materia, profesor, salon, cupo, tipo_clase y bloques horarios (RF-DAT-04).
# - Registro en logs de casos irregulares sin detener la generación del JSON final (RF-DAT-05).
