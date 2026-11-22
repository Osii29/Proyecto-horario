// Motor puro de validación de choques, generación de combinaciones y evaluación de puntaje.
// Debe contener:
// - Detección de colisiones entre bloques del mismo día mediante solapamiento de intervalos [inicio_min, fin_min) (RF-REC-01).
// - Generación de combinaciones válidas (una opción por materia) usando backtracking con poda temprana, límite configurable de combinaciones y opción de permitir solapamientos generando advertencia (RF-REC-02).
// - Cálculo de métricas por horario: diasLibres, totalHuecosMin y minutosFueraRango (RF-REC-03).
// - Cálculo de puntaje ponderado según preferencias del usuario y ordenamiento determinista de mayor a menor (RF-REC-04).
// - Diagnóstico de conflictos cuando no existan combinaciones válidas para sugerir ajustes al usuario (RF-REC-05).
