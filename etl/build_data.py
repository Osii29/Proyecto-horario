# Script de generación por lotes de archivos JSON estáticos.
# Debe contener:
# - Configuración de combinaciones de semestre, carrera, tipo y grupos a extraer.
# - Invocación al módulo de extracción y normalización (etl/conexion.py) respetando pausas entre peticiones (RNF-DAT-01).
# - Escritura de los archivos JSON resultantes dentro de la carpeta data/ (por ejemplo, sem_33_carr_12.json) y resumen de logs del lote (RF-DAT-05).
