// Controlador principal de la interfaz, estado de la aplicación y eventos de UI.
// Debe contener:
// - Carga del archivo JSON estático desde data/ y mantenimiento del estado global (filtros, materias seleccionadas, exclusiones, pesos de preferencia y horario activo).
// - Normalización de texto (insensible a mayúsculas y acentos) para búsqueda libre por materia, clave, profesor o grupo (RF-BUS-01).
// - Lógica de filtrado multiparámetro (días, rango horario, tipo de clase, cupo, profesores/grupos excluidos) y agrupación por asignatura (RF-BUS-02, RF-BUS-03, RF-BUS-04).
// - Conexión entre los cambios de UI, el motor de recomendación (scheduler.js) y el renderizado (render.js), asegurando respuesta fluida (< 1s) (RNF-REN-01).
