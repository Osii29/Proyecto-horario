import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  agruparPorGrupo,
  agruparPorMateria,
  cargarDataset,
  cargarIndiceDatasets,
  consolidarRegistrosPorGrupoMateria,
  crearControladorHorarios,
  filtrarHorarios,
  formatearEtiquetaSemestre,
  normalizarTexto,
  obtenerCatalogosDeFiltros,
  obtenerSemestreDeGrupo,
} from "../app.js";
import { calcularCarrilesSolapados, escapeHtml } from "../render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const HORARIOS_PRUEBA = [
  {
    id: "35_12_1500_1557",
    clv_materia: "1500",
    grupo: "1557",
    semestre: "35",
    carrera: "12",
    materia: "DISEÑO Y ANALISIS DE ALGORITMOS",
    profesor: "PÉREZ GARCÍA JUAN",
    salon: "A11203",
    cupo: 40,
    tipo_clase: "PRESENCIAL",
    bloques: [
      { dia: "MA", hora_texto: "17:00-19:00", inicio_min: 1020, fin_min: 1140 },
      { dia: "JU", hora_texto: "17:00-19:00", inicio_min: 1020, fin_min: 1140 },
    ],
  },
  {
    id: "35_12_1500_1558",
    clv_materia: "1500",
    grupo: "1558",
    semestre: "35",
    carrera: "12",
    materia: "DISEÑO Y ANALISIS DE ALGORITMOS",
    profesor: "LÓPEZ MARTÍN",
    salon: "A504",
    cupo: 0,
    tipo_clase: "A DISTANCIA",
    bloques: [
      { dia: "LU", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
      { dia: "MI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
    ],
  },
  {
    id: "35_12_1504_1557",
    clv_materia: "1504",
    grupo: "1557",
    semestre: "35",
    carrera: "12",
    materia: "PROGRAMACION WEB 1",
    profesor: "SÁNCHEZ MIGUEL",
    salon: "A204",
    cupo: 60,
    tipo_clase: "PRESENCIAL",
    bloques: [
      { dia: "LU", hora_texto: "13:00-14:30", inicio_min: 780, fin_min: 870 },
      { dia: "MI", hora_texto: "13:00-14:30", inicio_min: 780, fin_min: 870 },
    ],
  },
];

test("normalizarTexto elimina acentos, mayúsculas y espacios extra", () => {
  assert.equal(normalizarTexto("  DISEÑO   Y ÁNALISIS  "), "diseno y analisis");
  assert.equal(normalizarTexto(null), "");
});

test("filtrarHorarios soporta texto sin acentos, días, rango horario, cupo, tipo y exclusiones", () => {
  // Búsqueda insensible a acentos/mayúsculas por profesor, materia o clave
  assert.equal(filtrarHorarios(HORARIOS_PRUEBA, { texto: "perez diseno" }).length, 1);
  assert.equal(filtrarHorarios(HORARIOS_PRUEBA, { texto: "1504" }).length, 1);
  assert.equal(filtrarHorarios(HORARIOS_PRUEBA, { texto: "1557" }).length, 2);

  // Días activos
  assert.equal(
    filtrarHorarios(HORARIOS_PRUEBA, { diasActivos: ["LU", "MI"] }).length,
    2
  );

  // Rango horario
  assert.equal(
    filtrarHorarios(HORARIOS_PRUEBA, {
      horaMinInicio: "07:00",
      horaMaxFin: "15:00",
    }).length,
    2
  );

  // Cupo y modalidad
  assert.equal(filtrarHorarios(HORARIOS_PRUEBA, { soloConCupo: true }).length, 2);
  assert.equal(
    filtrarHorarios(HORARIOS_PRUEBA, { tiposClase: ["A DISTANCIA"] }).length,
    1
  );

  // Exclusiones de profesor y grupo
  assert.equal(
    filtrarHorarios(HORARIOS_PRUEBA, {
      profesoresExcluidos: ["perez garcia juan"],
    }).length,
    2
  );
  assert.equal(
    filtrarHorarios(HORARIOS_PRUEBA, {
      gruposExcluidos: ["1557"],
    }).length,
    1
  );
});

test("agruparPorMateria y obtenerCatalogosDeFiltros estructuran el catálogo correctamente", () => {
  const agrupado = agruparPorMateria(HORARIOS_PRUEBA);
  assert.equal(agrupado.length, 2);
  assert.equal(agrupado[0].clave, "1500");
  assert.equal(agrupado[0].totalGrupos, 2);

  const catalogos = obtenerCatalogosDeFiltros(HORARIOS_PRUEBA);
  assert.deepEqual(catalogos.tiposClase, ["A DISTANCIA", "PRESENCIAL"]);
  assert.equal(catalogos.minHoraMin, 420);
  assert.equal(catalogos.maxHoraMin, 1140);

  const porGrupo = agruparPorGrupo(HORARIOS_PRUEBA);
  assert.deepEqual(
    porGrupo.map((g) => g.grupo),
    ["1557", "1558"]
  );
  assert.deepEqual(porGrupo[0].clavesMaterias, ["1500", "1504"]);
  assert.equal(porGrupo[0].totalMaterias, 2);
});

test("crearControladorHorarios gestiona carga, suscripciones, presets, recomendaciones y horario manual", async () => {
  const fetchMock = async () => ({
    ok: true,
    json: async () => ({
      metadata: { semestre: "35", carrera: "12" },
      horarios: HORARIOS_PRUEBA,
    }),
  });

  const cargados = await cargarDataset("/data/sem_35_carr_12.json", fetchMock);
  assert.equal(cargados.horarios.length, 3);

  const ctrl = crearControladorHorarios();
  let notificaciones = 0;
  const desuscribir = ctrl.suscribir(() => {
    notificaciones += 1;
  });

  await ctrl.cargarDatos("/data/sem_35_carr_12.json", fetchMock);
  ctrl.aplicarPresetPreferencias("masDiasLibres");
  ctrl.actualizarFiltros({ soloConCupo: true });
  ctrl.seleccionarMaterias(["1500", "1504"]);

  const res = ctrl.generarHorariosRecomendados();
  assert.equal(res.recomendaciones.length, 1);
  assert.equal(res.recomendaciones[0].registros[0].grupo, "1557");

  const manual = ctrl.construirHorarioManual([
    HORARIOS_PRUEBA[0],
    HORARIOS_PRUEBA[2],
  ]);
  assert.equal(manual.tieneSolapamiento, false);
  assert.ok(Number.isFinite(manual.puntaje));
  assert.equal(manual.metricas.diasConPocasClases, 4);
  assert.ok(manual.desglosePuntaje.concentracionDiaria < 0);

  desuscribir();
  assert.ok(notificaciones >= 4);
});

test("controlador funciona de extremo a extremo sobre el dataset real generado", (t) => {
  const rutaReal = path.join(ROOT_DIR, "data", "sem_35_carr_12.json");
  if (!fs.existsSync(rutaReal)) {
    t.skip("data/sem_35_carr_12.json aún no existe.");
    return;
  }

  const payload = JSON.parse(fs.readFileSync(rutaReal, "utf-8"));
  const ctrl = crearControladorHorarios();
  ctrl.establecerDatos(payload);

  const materias = ctrl.obtenerMateriasFiltradas();
  assert.ok(materias.length >= 10);

  const seleccion = materias.slice(0, 4).map((m) => m.clave);
  ctrl.seleccionarMaterias(seleccion);
  ctrl.actualizarPreferencias({
    permitirSolapamiento: true,
    toleranciaSolapamientoMin: 60,
  });

  const res = ctrl.generarHorariosRecomendados();
  assert.ok(
    res.recomendaciones.length > 0 || res.diagnostico !== null,
    "Debe producir recomendaciones o un diagnóstico claro"
  );
});

test("render.js calcula carriles para bloques solapados y escapa HTML de forma segura", () => {
  const carriles = calcularCarrilesSolapados([
    { inicio_min: 420, fin_min: 540, registro: { clv_materia: "A" } },
    { inicio_min: 480, fin_min: 600, registro: { clv_materia: "B" } },
    { inicio_min: 660, fin_min: 780, registro: { clv_materia: "C" } },
  ]);
  assert.equal(carriles.length, 3);
  assert.equal(carriles[0].totalCols, 2);
  assert.equal(carriles[1].totalCols, 2);
  assert.equal(carriles[0].enChoque, true);
  assert.equal(carriles[2].totalCols, 1);
  assert.equal(carriles[2].enChoque, false);

  assert.equal(escapeHtml(`<script>"x"</script>`), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
});

test("obtenerSemestreDeGrupo, filtro por semestre y combinación entre distintos semestres funcionan", () => {
  assert.equal(obtenerSemestreDeGrupo("1557"), 5);
  assert.equal(obtenerSemestreDeGrupo("1005"), 10);
  assert.equal(obtenerSemestreDeGrupo("81101"), 1);
  assert.equal(obtenerSemestreDeGrupo("99"), null);
  assert.equal(formatearEtiquetaSemestre(5), "5° semestre");
  assert.equal(formatearEtiquetaSemestre(10), "10° / Optativas");

  const datosMultiSem = [
    ...HORARIOS_PRUEBA,
    {
      id: "35_12_1700_1757",
      clv_materia: "1700",
      grupo: "1757",
      semestre: "35",
      carrera: "12",
      materia: "INTELIGENCIA ARTIFICIAL",
      profesor: "RUIZ CARLOS",
      salon: "A301",
      cupo: 30,
      tipo_clase: "PRESENCIAL",
      bloques: [
        { dia: "VI", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 },
      ],
    },
  ];

  const cat = obtenerCatalogosDeFiltros(datosMultiSem);
  assert.deepEqual(
    cat.semestresGrupo.map((s) => s.numero),
    [5, 7]
  );

  assert.equal(
    filtrarHorarios(datosMultiSem, { semestresGrupo: [5] }).length,
    3
  );
  assert.equal(
    filtrarHorarios(datosMultiSem, { semestresGrupo: [7] }).length,
    1
  );

  // Al cambiar el filtro de semestre del catálogo, el motor conserva materias elegidas de otro semestre
  const ctrl = crearControladorHorarios({ horarios: datosMultiSem });
  ctrl.actualizarFiltros({ semestresGrupo: [5] });
  ctrl.alternarMateriaSeleccionada("1500");
  ctrl.actualizarFiltros({ semestresGrupo: [7] });
  ctrl.alternarMateriaSeleccionada("1700");

  const res = ctrl.generarHorariosRecomendados();
  assert.ok(res.recomendaciones.length > 0);
  assert.equal(res.recomendaciones[0].registros.length, 2);
});

test("consolidarRegistrosPorGrupoMateria fusiona salones por día y unifica codocentes", () => {
  const crudos = [
    {
      id: "35_5_0002_1318",
      clv_materia: "0002",
      grupo: "1318",
      semestre: "35",
      carrera: "5",
      materia: "GEOPOLITICA",
      profesor: "DOCENTE UNO",
      salon: "SINDEF",
      cupo: 40,
      tipo_clase: "PRESENCIAL",
      bloques: [{ dia: "MI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "35_5_0002_1318_2",
      clv_materia: "0002",
      grupo: "1318",
      semestre: "35",
      carrera: "5",
      materia: "GEOPOLITICA",
      profesor: "DOCENTE UNO",
      salon: "A114",
      cupo: 45,
      tipo_clase: "PRESENCIAL",
      bloques: [{ dia: "VI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "35_2_1036_1701",
      clv_materia: "1036",
      grupo: "1701",
      semestre: "35",
      carrera: "2",
      materia: "ADMIN CONSTRUCCION",
      profesor: "PROF A",
      salon: "A911",
      cupo: 35,
      tipo_clase: "PRESENCIAL",
      bloques: [{ dia: "MI", hora_texto: "10:00-13:00", inicio_min: 600, fin_min: 780 }],
    },
    {
      id: "35_2_1036_1701_2",
      clv_materia: "1036",
      grupo: "1701",
      semestre: "35",
      carrera: "2",
      materia: "ADMIN CONSTRUCCION",
      profesor: "PROF B",
      salon: "A911",
      cupo: 35,
      tipo_clase: "PRESENCIAL",
      bloques: [{ dia: "MI", hora_texto: "10:00-13:00", inicio_min: 600, fin_min: 780 }],
    },
  ];

  const consolidados = consolidarRegistrosPorGrupoMateria(crudos);
  assert.equal(consolidados.length, 2);
  assert.equal(consolidados[0].id, "35_5_0002_1318");
  assert.equal(consolidados[0].salon, "SINDEF / A114");
  assert.equal(consolidados[0].cupo, 45);
  assert.deepEqual(
    consolidados[0].bloques.map((b) => b.dia),
    ["MI", "VI"]
  );

  assert.equal(consolidados[1].profesor, "PROF A / PROF B");
  assert.equal(consolidados[1].bloques.length, 1);
});

test("cargarIndiceDatasets prioriza ./data/index.json desde la raíz y retorna baseUrl ./data", async () => {
  const solicitadas = [];
  const fetchMock = async (ruta) => {
    solicitadas.push(ruta);
    return {
      ok: true,
      json: async () => ({
        semestre_activo: { semestre: "35", etiqueta_semestre: "2027-1" },
        datasets: [
          {
            archivo: "sem_35_carr_12.json",
            semestre: "35",
            etiqueta_semestre: "2027-1",
            carrera: "12",
            nombre_carrera: "INGENIERIA EN COMPUTACION",
          },
        ],
      }),
    };
  };

  const indice = await cargarIndiceDatasets(undefined, fetchMock);
  assert.deepEqual(solicitadas, ["./data/index.json"]);
  assert.equal(indice.baseUrl, "./data");
  assert.equal(indice.semestreActivo.semestre, "35");
  assert.equal(indice.datasets.length, 1);
});

test("preset masDiasLibres combina diasLibres=40 y concentracionDiaria=25 para compactar clases", () => {
  const ctrl = crearControladorHorarios();
  ctrl.establecerDatos({
    metadata: { semestre: "35", carrera: "12" },
    horarios: [
      {
        id: "A_1",
        clv_materia: "A",
        grupo: "1557",
        materia: "A",
        cupo: 30,
        bloques: [
          { dia: "LU", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
          { dia: "MA", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
        ],
      },
      {
        id: "B_1",
        clv_materia: "B",
        grupo: "1557",
        materia: "B",
        cupo: 30,
        bloques: [
          { dia: "LU", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 },
          { dia: "MA", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 },
        ],
      },
      {
        id: "C_conc",
        clv_materia: "C",
        grupo: "1557",
        materia: "C",
        cupo: 30,
        bloques: [
          { dia: "LU", hora_texto: "11:00-13:00", inicio_min: 660, fin_min: 780 },
          { dia: "MA", hora_texto: "11:00-13:00", inicio_min: 660, fin_min: 780 },
        ],
      },
      {
        id: "C_suelto",
        clv_materia: "C",
        grupo: "1558",
        materia: "C",
        cupo: 30,
        bloques: [
          { dia: "MI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
          { dia: "JU", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 },
        ],
      },
    ],
  });

  ctrl.aplicarPresetPreferencias("masDiasLibres");
  assert.equal(ctrl.obtenerEstado().preferencias.pesos.diasLibres, 40);
  assert.equal(ctrl.obtenerEstado().preferencias.pesos.concentracionDiaria, 25);

  ctrl.seleccionarMaterias(["A", "B", "C"]);
  const res = ctrl.generarHorariosRecomendados();
  assert.equal(res.recomendaciones.length, 2);
  assert.equal(res.recomendaciones[0].registros[2].id, "C_conc");
  assert.equal(res.recomendaciones[0].metricas.diasConPocasClases, 0);
  assert.equal(res.recomendaciones[1].metricas.diasConPocasClases, 4);
});

test("filtrarHorarios y obtenerCatalogosDeFiltros separan codocentes y modalidades mixtas con '/'", () => {
  const registros = [
    {
      id: "35_2_1036_1701",
      clv_materia: "1036",
      grupo: "1701",
      materia: "ADMIN CONSTRUCCION",
      profesor: "PROF A / PROF B",
      tipo_clase: "PRESENCIAL / A DISTANCIA",
      cupo: 35,
      bloques: [{ dia: "MI", hora_texto: "10:00-13:00", inicio_min: 600, fin_min: 780 }],
    },
    {
      id: "35_2_1037_1701",
      clv_materia: "1037",
      grupo: "1701",
      materia: "PROYECTOS",
      profesor: "PROF C",
      tipo_clase: "A DISTANCIA",
      cupo: 35,
      bloques: [{ dia: "JU", hora_texto: "10:00-13:00", inicio_min: 600, fin_min: 780 }],
    },
  ];

  // Excluir un docente individual debe excluir también donde aparezca como codocente
  const sinProfA = filtrarHorarios(registros, { profesoresExcluidos: ["PROF A"] });
  assert.deepEqual(sinProfA.map((r) => r.id), ["35_2_1037_1701"]);

  // Filtrar una modalidad individual debe incluir registros con modalidad mixta
  const presenciales = filtrarHorarios(registros, { tiposClase: ["PRESENCIAL"] });
  assert.deepEqual(presenciales.map((r) => r.id), ["35_2_1036_1701"]);

  // El catálogo debe listar nombres y modalidades individuales, no concatenados
  const cat = obtenerCatalogosDeFiltros(registros);
  assert.deepEqual(cat.profesores, ["PROF A", "PROF B", "PROF C"]);
  assert.deepEqual(cat.tiposClase, ["A DISTANCIA", "PRESENCIAL"]);
});

test("filtrarHorarios con soloPresenciales y cupoMinimo filtra correctamente", () => {
  const registros = [
    {
      id: "1",
      clv_materia: "1001",
      grupo: "1101",
      salon: "A204",
      tipo_clase: "PRESENCIAL",
      cupo: 15,
      bloques: [{ dia: "LU", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "2",
      clv_materia: "1002",
      grupo: "1102",
      salon: "SINDEF",
      tipo_clase: "PRESENCIAL",
      cupo: 3,
      bloques: [{ dia: "MA", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "3",
      clv_materia: "1003",
      grupo: "1103",
      salon: "VIRTUAL",
      tipo_clase: "A DISTANCIA",
      cupo: 25,
      bloques: [{ dia: "MI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "4",
      clv_materia: "1004",
      grupo: "1104",
      salon: "A205 / VIRTUAL",
      tipo_clase: "PRESENCIAL / A DISTANCIA",
      cupo: 10,
      bloques: [{ dia: "JU", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "5",
      clv_materia: "1005",
      grupo: "1105",
      salon: "SINDEF",
      tipo_clase: "HIBRIDO",
      cupo: 20,
      bloques: [{ dia: "VI", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "6",
      clv_materia: "1006",
      grupo: "1106",
      salon: "VIRTUAL",
      tipo_clase: "PRESENCIAL",
      cupo: 25,
      bloques: [{ dia: "SA", hora_texto: "07:00-09:00", inicio_min: 420, fin_min: 540 }],
    },
    {
      id: "7",
      clv_materia: "1007",
      grupo: "1107",
      salon: "A204 / VIRTUAL",
      tipo_clase: "PRESENCIAL",
      cupo: 20,
      bloques: [{ dia: "SA", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 }],
    },
  ];

  // soloPresenciales debe conservar únicamente grupos 100% presenciales (incluido SINDEF),
  // excluyendo A DISTANCIA, HIBRIDO, salon VIRTUAL y mezclas con VIRTUAL aunque digan PRESENCIAL
  const soloPres = filtrarHorarios(registros, { soloPresenciales: true });
  assert.deepEqual(soloPres.map((r) => r.id), ["1", "2"]);

  // cupoMinimo = 10 excluye cupo 3
  const cupo10 = filtrarHorarios(registros, { cupoMinimo: 10 });
  assert.deepEqual(cupo10.map((r) => r.id), ["1", "3", "4", "5", "6", "7"]);

  // Combinado: soloPresenciales + cupoMinimo = 10
  const combinado = filtrarHorarios(registros, { soloPresenciales: true, cupoMinimo: 10 });
  assert.deepEqual(combinado.map((r) => r.id), ["1"]);
});

test("consolidarRegistrosPorGrupoMateria preserva tipo_clase y salon por bloque en materias híbridas", async () => {
  const { calcularMetricasHorario } = await import("../scheduler.js");
  const crudos = [
    {
      id: "35_2_1420_1401",
      clv_materia: "1420",
      grupo: "1401",
      semestre: "35",
      carrera: "2",
      materia: "PROYECTOS",
      salon: "A313",
      tipo_clase: "PRESENCIAL",
      cupo: 25,
      bloques: [
        { dia: "LU", hora_texto: "09:30-12:00", inicio_min: 570, fin_min: 720 },
        { dia: "VI", hora_texto: "09:30-12:00", inicio_min: 570, fin_min: 720 },
      ],
    },
    {
      id: "35_2_1420_1401_2",
      clv_materia: "1420",
      grupo: "1401",
      semestre: "35",
      carrera: "2",
      materia: "PROYECTOS",
      salon: "VIRTUAL",
      tipo_clase: "A DISTANCIA",
      cupo: 25,
      bloques: [
        { dia: "SA", hora_texto: "09:00-10:00", inicio_min: 540, fin_min: 600 },
      ],
    },
  ];

  const consolidado = consolidarRegistrosPorGrupoMateria(crudos);
  assert.equal(consolidado.length, 1);
  assert.equal(consolidado[0].bloques.length, 3);
  assert.equal(consolidado[0].bloques[0].tipo_clase, "PRESENCIAL");
  assert.equal(consolidado[0].bloques[0].salon, "A313");
  assert.equal(consolidado[0].bloques[2].tipo_clase, "A DISTANCIA");
  assert.equal(consolidado[0].bloques[2].salon, "VIRTUAL");

  // Solo LU y VI deben contar como asistencia presencial; SA es en línea y queda libre presencial
  const metricas = calcularMetricasHorario(consolidado);
  assert.equal(metricas.diasConClase, 2);
  assert.equal(metricas.diasLibres, 4);
  assert.equal(metricas.clasesPorDia.SA, 0);

  // Caso con tipo_clase PRESENCIAL en ambas filas pero salon A204 (LU) + VIRTUAL (SA)
  const crudosPorSalon = [
    {
      id: "35_12_X_1",
      clv_materia: "9999",
      grupo: "1501",
      semestre: "35",
      carrera: "12",
      materia: "TALLER",
      salon: "A204",
      tipo_clase: "PRESENCIAL",
      cupo: 25,
      bloques: [{ dia: "LU", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 }],
    },
    {
      id: "35_12_X_2",
      clv_materia: "9999",
      grupo: "1501",
      semestre: "35",
      carrera: "12",
      materia: "TALLER",
      salon: "VIRTUAL",
      tipo_clase: "PRESENCIAL",
      cupo: 25,
      bloques: [{ dia: "SA", hora_texto: "09:00-11:00", inicio_min: 540, fin_min: 660 }],
    },
  ];
  const consSalon = consolidarRegistrosPorGrupoMateria(crudosPorSalon);
  assert.equal(consSalon.length, 1);
  assert.equal(consSalon[0].bloques[0].salon, "A204");
  assert.equal(consSalon[0].bloques[1].salon, "VIRTUAL");
  const metSalon = calcularMetricasHorario(consSalon);
  assert.equal(metSalon.diasConClase, 1);
  assert.equal(metSalon.diasLibres, 5);
  assert.equal(metSalon.clasesPorDia.LU, 1);
  assert.equal(metSalon.clasesPorDia.SA, 0);
});
