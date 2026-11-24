import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRESETS_PREFERENCIAS,
  calcularMetricasHorario,
  calcularPuntaje,
  calcularSolapamientoBloques,
  compararRecomendaciones,
  detectarSolapamientosHorario,
  diagnosticarConflictos,
  generarRecomendaciones,
  hayColisionBloques,
  horaAMinutos,
  minutosAHora,
} from "../scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function crearRegistro({ id, clv, materia, grupo, profesor = "DOCENTE", bloques }) {
  return {
    id: id || `${clv}_${grupo}`,
    clv_materia: clv,
    materia: materia || `Materia ${clv}`,
    grupo,
    profesor,
    salon: "A101",
    cupo: 40,
    tipo_clase: "PRESENCIAL",
    bloques: bloques.map(([dia, ini, fin]) => ({
      dia,
      hora_texto: `${minutosAHora(ini)}-${minutosAHora(fin)}`,
      inicio_min: ini,
      fin_min: fin,
    })),
  };
}

test("horaAMinutos y minutosAHora convierten formatos válidos e inválidos", () => {
  assert.equal(horaAMinutos("07:00"), 420);
  assert.equal(horaAMinutos("7:15"), 435);
  assert.equal(horaAMinutos("24:00"), 1440);
  assert.equal(horaAMinutos("25:00"), null);
  assert.equal(horaAMinutos("12:60"), null);
  assert.equal(minutosAHora(420), "07:00");
  assert.equal(minutosAHora(1320), "22:00");
  assert.equal(minutosAHora(-1), "");
});

test("calcularSolapamientoBloques y hayColisionBloques usan intervalos semiabiertos [inicio, fin)", () => {
  const b1 = { dia: "LU", inicio_min: 420, fin_min: 540 };
  const bAdyacente = { dia: "LU", inicio_min: 540, fin_min: 660 };
  const bTraslapado = { dia: "LU", inicio_min: 480, fin_min: 600 };
  const bOtroDia = { dia: "MA", inicio_min: 420, fin_min: 540 };
  const bIrregular = { dia: "LU", inicio_min: null, fin_min: null };

  assert.equal(calcularSolapamientoBloques(b1, bAdyacente), 0);
  assert.equal(hayColisionBloques(b1, bAdyacente), false);

  assert.equal(calcularSolapamientoBloques(b1, bTraslapado), 60);
  assert.equal(hayColisionBloques(b1, bTraslapado), true);

  assert.equal(calcularSolapamientoBloques(b1, bOtroDia), 0);
  assert.equal(calcularSolapamientoBloques(b1, bIrregular), 0);
});

test("calcularMetricasHorario calcula días libres, huecos sin negativos por solapamiento y fuera de rango", () => {
  const r1 = crearRegistro({
    clv: "01",
    grupo: "101",
    bloques: [["LU", 390, 540]], // 06:30-09:00 (30 min antes de 07:00)
  });
  const r2 = crearRegistro({
    clv: "02",
    grupo: "101",
    bloques: [["LU", 480, 600]], // 08:00-10:00 (choca 60 min con r1)
  });
  const r3 = crearRegistro({
    clv: "03",
    grupo: "101",
    bloques: [["LU", 660, 1350]], // 11:00-22:30 (60 min hueco desde 10:00, 30 min después de 22:00)
  });

  const metricas = calcularMetricasHorario([r1, r2, r3], {
    horaIdealInicioMin: 420, // 07:00
    horaIdealFinMin: 1320, // 22:00
  });

  assert.equal(metricas.diasConClase, 1);
  assert.equal(metricas.diasLibres, 5);
  assert.deepEqual(metricas.listaDiasLibres, ["MA", "MI", "JU", "VI", "SA"]);
  assert.equal(metricas.totalHuecosMin, 60);
  assert.equal(metricas.minutosFueraRango, 60);
  assert.equal(metricas.totalMinutosSolapamiento, 60);
  assert.equal(metricas.totalChoques, 1);

  const analisis = detectarSolapamientosHorario([r1, r2, r3]);
  assert.equal(analisis.tieneSolapamiento, true);
  assert.equal(analisis.advertencias.length, 1);
});

test("generarRecomendaciones entrega solo horarios sin choques por defecto y respeta orden original", () => {
  const matA = {
    clave: "A",
    materia: "Algoritmos",
    opciones: [
      crearRegistro({ clv: "A", grupo: "G1", bloques: [["LU", 420, 540]] }),
      crearRegistro({ clv: "A", grupo: "G2", bloques: [["MA", 420, 540]] }),
    ],
  };
  const matB = {
    clave: "B",
    materia: "Bases de Datos",
    opciones: [
      crearRegistro({ clv: "B", grupo: "G1", bloques: [["LU", 420, 540]] }),
      crearRegistro({ clv: "B", grupo: "G2", bloques: [["LU", 540, 660]] }),
    ],
  };
  const matC = {
    clave: "C",
    materia: "Compiladores",
    opciones: [
      crearRegistro({ clv: "C", grupo: "G1", bloques: [["MA", 420, 540]] }),
    ],
  };

  const res = generarRecomendaciones([matA, matB, matC]);
  // Única combinación válida: A-G1 (LU 7-9), B-G2 (LU 9-11), C-G1 (MA 7-9)
  assert.equal(res.recomendaciones.length, 1);
  const unica = res.recomendaciones[0];
  assert.equal(unica.tieneSolapamiento, false);
  assert.deepEqual(
    unica.registros.map((r) => `${r.clv_materia}:${r.grupo}`),
    ["A:G1", "B:G2", "C:G1"]
  );
  assert.equal(unica.metricas.diasLibres, 4);
  assert.equal(unica.metricas.totalHuecosMin, 0);
});

test("generarRecomendaciones permite múltiples solapamientos respetando tolerancia máxima en minutos", () => {
  const matA = {
    clave: "A",
    materia: "Materia A",
    opciones: [
      crearRegistro({
        clv: "A",
        grupo: "1",
        bloques: [
          ["LU", 420, 540], // 07:00-09:00
          ["MI", 420, 540],
        ],
      }),
    ],
  };
  const matB = {
    clave: "B",
    materia: "Materia B",
    opciones: [
      crearRegistro({
        clv: "B",
        grupo: "1",
        bloques: [
          ["LU", 525, 645], // choca 15 min el LU
          ["MI", 525, 645], // choca 15 min el MI (total 30 min)
        ],
      }),
    ],
  };
  const matC = {
    clave: "C",
    materia: "Materia C",
    opciones: [
      crearRegistro({
        clv: "C",
        grupo: "1",
        bloques: [["VI", 420, 540]],
      }),
      crearRegistro({
        clv: "C",
        grupo: "2",
        bloques: [["LU", 520, 600]], // añade 20 min extra con A y 60 min con B
      }),
    ],
  };

  // Sin solapamiento -> no hay combinación
  const sinSolap = generarRecomendaciones([matA, matB, matC], {
    permitirSolapamiento: false,
  });
  assert.equal(sinSolap.recomendaciones.length, 0);

  // Tolerancia de 30 min -> acepta 2 choques (LU 15m + MI 15m = 30m) con C:1, rechaza C:2
  const tol30 = generarRecomendaciones([matA, matB, matC], {
    permitirSolapamiento: true,
    toleranciaSolapamientoMin: 30,
  });
  assert.equal(tol30.recomendaciones.length, 1);
  assert.equal(tol30.recomendaciones[0].metricas.totalChoques, 2);
  assert.equal(tol30.recomendaciones[0].metricas.totalMinutosSolapamiento, 30);
  assert.equal(tol30.recomendaciones[0].tieneSolapamiento, true);
  assert.equal(tol30.recomendaciones[0].advertencias.length, 2);

  // Tolerancia ilimitada (null) -> acepta ambas opciones de C, ordenando primero la de menor traslape
  const sinLimite = generarRecomendaciones([matA, matB, matC], {
    permitirSolapamiento: true,
    toleranciaSolapamientoMin: null,
  });
  assert.equal(sinLimite.recomendaciones.length, 2);
  assert.equal(sinLimite.recomendaciones[0].registros[2].grupo, "1");
  assert.ok(sinLimite.recomendaciones[0].puntaje > sinLimite.recomendaciones[1].puntaje);
});

test("compararRecomendaciones desempata de forma determinista y calcularPuntaje usa pesos", () => {
  const recA = {
    id: "A_1|B_1",
    registros: [{ id: "A_1" }, { id: "B_1" }],
    puntaje: 140,
    metricas: {
      totalMinutosSolapamiento: 0,
      diasLibres: 2,
      totalHuecosMin: 60,
      minutosFueraRango: 0,
    },
  };
  const recB = {
    id: "A_2|B_1",
    registros: [{ id: "A_2" }, { id: "B_1" }],
    puntaje: 140,
    metricas: {
      totalMinutosSolapamiento: 0,
      diasLibres: 2,
      totalHuecosMin: 30,
      minutosFueraRango: 0,
    },
  };
  assert.ok(compararRecomendaciones(recB, recA) < 0);

  const punt = calcularPuntaje(
    {
      diasLibres: 2,
      totalHuecosMin: 60,
      minutosFueraRango: 30,
      totalMinutosSolapamiento: 0,
    },
    PRESETS_PREFERENCIAS.masDiasLibres.pesos
  );
  // 100 + 2*40 - 1*8 - 0.5*5 = 169.5
  assert.equal(punt.puntaje, 169.5);
});

test("diagnosticarConflictos detecta materias vacías, pares incompatibles y conflicto múltiple", () => {
  // 1. Materia sin opciones
  const d1 = diagnosticarConflictos([
    { clave: "100", materia: "Sin Cupo", opciones: [] },
  ]);
  assert.equal(d1.materiasSinOpciones.length, 1);
  assert.ok(d1.sugerencias.some((s) => s.includes("Sin Cupo")));

  // 2. Par incompatible con traslape mínimo de 45 min
  const d2 = diagnosticarConflictos(
    [
      {
        clave: "101",
        materia: "Redes",
        opciones: [crearRegistro({ clv: "101", grupo: "1", bloques: [["LU", 420, 540]] })],
      },
      {
        clave: "102",
        materia: "SO",
        opciones: [crearRegistro({ clv: "102", grupo: "1", bloques: [["LU", 495, 600]] })],
      },
    ],
    { permitirSolapamiento: false }
  );
  assert.equal(d2.paresIncompatibles.length, 1);
  assert.equal(d2.paresIncompatibles[0].solapamientoMinimoMin, 45);
  assert.ok(d2.sugerencias.some((s) => s.includes("45")));

  // 3. Conflicto triple donde cada par sí puede convivir pero los 3 juntos no
  const d3 = diagnosticarConflictos([
    {
      clave: "M1",
      materia: "Uno",
      opciones: [
        crearRegistro({ clv: "M1", grupo: "1", bloques: [["LU", 420, 540]] }),
      ],
    },
    {
      clave: "M2",
      materia: "Dos",
      opciones: [
        crearRegistro({ clv: "M2", grupo: "1", bloques: [["LU", 420, 540]] }),
        crearRegistro({ clv: "M2", grupo: "2", bloques: [["MA", 420, 540]] }),
      ],
    },
    {
      clave: "M3",
      materia: "Tres",
      opciones: [
        crearRegistro({ clv: "M3", grupo: "1", bloques: [["LU", 420, 540]] }),
        crearRegistro({ clv: "M3", grupo: "2", bloques: [["MA", 420, 540]] }),
      ],
    },
  ]);
  assert.equal(d3.paresIncompatibles.length, 0);
  assert.ok(d3.conflictoMultiple);
  assert.equal(d3.conflictoMultiple.maxMateriasCompatibles, 2);
});

test("generarRecomendaciones respeta límite de combinaciones evaluadas y rinde < 1s con datos reales", (t) => {
  const rutaReal = path.join(ROOT_DIR, "data", "sem_35_carr_12.json");
  if (!fs.existsSync(rutaReal)) {
    t.skip("data/sem_35_carr_12.json aún no existe.");
    return;
  }

  const dataset = JSON.parse(fs.readFileSync(rutaReal, "utf-8"));
  const porMateria = new Map();
  for (const reg of dataset.horarios) {
    if (!porMateria.has(reg.clv_materia)) {
      porMateria.set(reg.clv_materia, {
        clave: reg.clv_materia,
        materia: reg.materia,
        opciones: [],
      });
    }
    porMateria.get(reg.clv_materia).opciones.push(reg);
  }

  // Selecciona hasta 6 materias reales con múltiples grupos para medir rendimiento
  const seleccionadas = Array.from(porMateria.values())
    .filter((m) => m.opciones.length >= 3)
    .slice(0, 6);

  assert.equal(seleccionadas.length, 6);

  const t0 = performance.now();
  const resultado = generarRecomendaciones(seleccionadas, {
    maxCombinacionesEvaluadas: 15000,
    limiteResultados: 15,
  });
  const duracion = performance.now() - t0;

  assert.ok(
    duracion < 1000,
    `El motor tardó ${duracion.toFixed(1)} ms (supera el límite de 1000 ms)`
  );
  assert.ok(resultado.estadisticas.nodosExplorados > 0);
});

test("calcularMetricasHorario no duplica minutosFueraRango si rango ideal está invertido", () => {
  const reg = crearRegistro({
    clv: "01",
    grupo: "1",
    bloques: [["LU", 420, 540]], // 07:00-09:00 (120 min)
  });
  const m = calcularMetricasHorario([reg], {
    horaIdealInicioMin: 900, // 15:00
    horaIdealFinMin: 840, // 14:00 (invertido: normaliza a 14:00-15:00)
  });
  assert.equal(m.minutosFueraRango, 120);
});

test("diagnosticarConflictos calcula toleranciaMinimaSugerida exacta en conflictos múltiples", () => {
  // M1 choca 30m con M2; M2 choca 20m con M3 => tolerancia mínima total = 50m
  const d = diagnosticarConflictos([
    {
      clave: "M1",
      materia: "Uno",
      opciones: [crearRegistro({ clv: "M1", grupo: "1", bloques: [["LU", 420, 540]] })],
    },
    {
      clave: "M2",
      materia: "Dos",
      opciones: [crearRegistro({ clv: "M2", grupo: "1", bloques: [["LU", 510, 600]] })],
    },
    {
      clave: "M3",
      materia: "Tres",
      opciones: [crearRegistro({ clv: "M3", grupo: "1", bloques: [["LU", 580, 660]] })],
    },
  ]);
  assert.equal(d.toleranciaMinimaSugerida, 50);

  // Al aplicar esa tolerancia exacta debe producir al menos 1 recomendación válida
  const res = generarRecomendaciones(
    [
      { clave: "M1", materia: "Uno", opciones: [crearRegistro({ clv: "M1", grupo: "1", bloques: [["LU", 420, 540]] })] },
      { clave: "M2", materia: "Dos", opciones: [crearRegistro({ clv: "M2", grupo: "1", bloques: [["LU", 510, 600]] })] },
      { clave: "M3", materia: "Tres", opciones: [crearRegistro({ clv: "M3", grupo: "1", bloques: [["LU", 580, 660]] })] },
    ],
    {
      permitirSolapamiento: true,
      toleranciaSolapamientoMin: d.toleranciaMinimaSugerida,
    }
  );
  assert.equal(res.recomendaciones.length, 1);
});

test("ordenamiento por preferencias y Branch-and-Bound encuentran horario vespertino óptimo en RRII", (t) => {
  const rutaRRII = path.join(ROOT_DIR, "data", "sem_35_carr_5.json");
  if (!fs.existsSync(rutaRRII)) {
    t.skip("data/sem_35_carr_5.json aún no existe.");
    return;
  }

  const dataset = JSON.parse(fs.readFileSync(rutaRRII, "utf-8"));
  const claves1101 = ["1105", "1116", "1122", "1123", "1124", "1125"];
  const entrada = claves1101.map((clv) => ({
    clave: clv,
    materia: clv,
    opciones: dataset.horarios.filter((r) => r.clv_materia === clv),
  }));

  const res = generarRecomendaciones(entrada, {
    ...PRESETS_PREFERENCIAS.vespertino,
    maxCombinacionesEvaluadas: 25000,
    limiteResultados: 10,
  });

  assert.ok(res.recomendaciones.length > 0);
  const top = res.recomendaciones[0];
  assert.ok(top.puntaje > 100, `Se esperaba puntaje vespertino óptimo > 100, obtenido: ${top.puntaje}`);
  assert.equal(top.metricas.minutosFueraRango, 0);
  assert.ok(res.estadisticas.tiempoMs < 1000);
});
