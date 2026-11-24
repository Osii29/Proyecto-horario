# Sistema de Consulta y Recomendación de Horarios

Aplicación web estática (arquitectura JAMstack) orientada a consultar horarios del semestre vigente para todas las carreras activas de FES Aragón, aplicar filtros multiparámetro y generar combinaciones semanales optimizadas mediante backtracking con detección de choques y tolerancia configurable de solapamiento.

---

## Estructura del repositorio

```text
proyecto-horarios/
├── etl/
│   ├── conexion.py           # Cliente de queysA.php (tipo=0,1,2,4), limpieza y normalización
│   └── build_data.py         # Orquestador automático para último semestre y todas las carreras
├── data/
│   ├── index.json            # Catálogo de carreras activas del semestre vigente
│   └── sem_35_carr_*.json    # Horarios normalizados por carrera (semestre 2027-1)
├── docs/
│   └── design-dna.json       # Perfil Design DNA (tokens, estilo visual y efectos)
├── src/
│   ├── index.html            # Interfaz Dark Swiss Architectural Studio (panel colapsable en 3 pestañas)
│   ├── styles.css            # Sistema visual reticular, responsivo y @media print
│   ├── render.js             # Renderizado DOM, carriles de choque y exportación PNG
│   ├── scheduler.js          # Motor puro: choques, backtracking, métricas, puntaje y diagnóstico
│   └── app.js                # Estado, carga de carreras, filtros y vinculación de eventos UI
├── tests/
│   ├── test_etl.py           # Pruebas unitarias y validación de esquema del ETL
│   ├── scheduler.test.mjs    # Pruebas del motor de acomodo y benchmark < 1s
│   └── app.test.mjs          # Pruebas de filtros, agrupación, controlador y renderizado
└── README.md
```

---

## Ejecución local y despliegue estático

### Vista previa local

Como la aplicación carga los archivos JSON mediante `fetch`, sírvela desde la raíz del repositorio con cualquier servidor estático:

```bash
python -m http.server 8000
```

Después abre `http://localhost:8000/src/` en tu navegador.

### Despliegue gratuito (GitHub Pages / Vercel / Cloudflare Pages)

Publica el repositorio completo como sitio estático (conservando `src/` y `data/` en sus rutas relativas). La aplicación detecta automáticamente `../data/index.json` y permite elegir cualquier carrera del semestre vigente.

---

## Pipeline ETL (`etl/`)

### Funcionamiento del endpoint (`queysA.php`)

- `tipo=0`: lista los semestres publicados (`id_semestre`, `nombre`) para detectar el semestre más reciente.
- `tipo=1`: lista todas las carreras disponibles (`id_area`, `nombre`).
- `tipo=4` (`sem`, `carr`): devuelve los grupos existentes para esa carrera y semestre.
- `tipo=2` (`sem`, `carr`, `grupo`): devuelve las asignaturas y bloques horarios (`LU`–`SA`) de ese grupo.
- Códigos de modalidad normalizados desde `tipoclase`:
  - `P` → `PRESENCIAL`
  - `S` → `SEMIPRESENCIAL`
  - `A` → `A DISTANCIA`
  - `H` → `HIBRIDO`
  - `X` / vacío → `SIN ESPECIFICAR`

### Ejecución del generador de datos

Requiere Python 3 y `requests`:

```bash
python etl/build_data.py
```

Opciones disponibles en CLI:

```bash
python etl/build_data.py --pausa 0.15 --omitir-existentes
```

- Sin `--objetivos`: detecta automáticamente el semestre más reciente, limpia archivos de semestres anteriores en `data/`, extrae todas las carreras activas y actualiza `data/index.json`.
- `--carreras`: opcional para restringir el lote a claves específicas (ej. `--carreras 12 10`).
- `--omitir-existentes`: reutiliza archivos JSON ya válidos del semestre activo.
- `--conservar-antiguos`: conserva archivos de semestres previos en `data/`.
- `--pausa`: segundos de espera entre peticiones HTTP (por defecto `0.15`).
- `--timeout`: tiempo límite por petición HTTP en segundos (por defecto `15`).
- `--reintentos`: reintentos ante fallos transitorios de red/servidor (por defecto `2`).
- `--salida`: directorio destino de los JSON (por defecto `data/`).
- `--log-archivo`: ruta opcional para guardar la bitácora de ejecución.

---

## Pruebas automatizadas

Ejecutar las pruebas del ETL (Python):

```bash
python -m unittest discover -s tests -v
```

Ejecutar las pruebas del motor, controlador y utilidades de renderizado (Node.js):

```bash
node --no-warnings --test tests/scheduler.test.mjs tests/app.test.mjs
```
