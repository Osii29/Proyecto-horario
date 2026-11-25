import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PESOS_POR_DEFECTO,
  PRESETS_PREFERENCIAS,
  calcularIndiceConcentracion,
  calcularMetricasHorario,
  calcularPuntaje,
  calcularSolapamientoBloques,
  compararRecomendaciones,
  detectarSolapamientosHorario,
  diagnosticarConflictos,
  esBloqueEnLinea,
  generarRecomendaciones,
  hayColisionBloques,
  horaAMinutos,
  minutosAHora,
  obtenerEtiquetaModalidad,
  obtenerPesoEnLineaRegistro,
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

test("calcularIndiceConcentracion y calcularMetricasHorario miden concentración y evitan inversiones 2 vs 3 días", () => {
  assert.equal(calcularIndiceConcentracion([]), 0);
  assert.equal(calcularIndiceConcentracion([0, 0, 0, 0, 0, 0]), 0);

  // 1) A igualdad de densidad diaria, menos días siempre gana (2 días > 3 días)
  assert.ok(calcularIndiceConcentracion([4, 4]) > calcularIndiceConcentracion([4, 4, 4]));
  assert.ok(calcularIndiceConcentracion([3, 3]) > calcularIndiceConcentracion([3, 3, 3]));
  assert.ok(calcularIndiceConcentracion([5, 5]) > calcularIndiceConcentracion([5, 5, 5]));
  assert.ok(calcularIndiceConcentracion([4, 2]) > calcularIndiceConcentracion([3, 3, 3]));

  // 2) Mayor densidad promedio por día gana
  assert.ok(calcularIndiceConcentracion([5, 5]) > calcularIndiceConcentracion([4, 4]));
  assert.ok(calcularIndiceConcentracion([4, 4]) > calcularIndiceConcentracion([3, 3]));
  assert.ok(calcularIndiceConcentracion([4, 4, 4]) > calcularIndiceConcentracion([3, 3, 3, 3]));

  // 3) Evitar días sueltos de 1 o 2 clases gana frente a tenerlos
  assert.ok(calcularIndiceConcentracion([3, 3, 3, 3]) > calcularIndiceConcentracion([5, 5, 1, 1]));
  assert.ok(calcularIndiceConcentracion([3, 3, 3, 1]) > calcularIndiceConcentracion([4, 2, 2, 2]));
  assert.ok(calcularIndiceConcentracion([4, 3, 3]) > calcularIndiceConcentracion([5, 4, 1]));

  // Dos bloques de la misma materia el mismo día (LU) deben contar como 1 clase en ese día
  const mDobleMismoDia = crearRegistro({
    clv: "M1",
    grupo: "1",
    bloques: [
      ["LU", 420, 480],
      ["LU", 540, 600],
      ["MA", 420, 480],
    ],
  });
  const m2 = crearRegistro({
    clv: "M2",
    grupo: "1",
    bloques: [
      ["LU", 600, 660],
      ["MA", 480, 540],
      ["MI", 420, 480],
    ],
  });
  const m3 = crearRegistro({
    clv: "M3",
    grupo: "1",
    bloques: [["LU", 660, 720]],
  });

  const metricas = calcularMetricasHorario([mDobleMismoDia, m2, m3]);
  assert.deepEqual(metricas.clasesPorDia, {
    LU: 3,
    MA: 2,
    MI: 1,
    JU: 0,
    VI: 0,
    SA: 0,
  });
  assert.equal(metricas.diasConClase, 3);
  assert.equal(metricas.diasConPocasClases, 2); // MA (2) y MI (1)
  assert.equal(metricas.diasConUnaClase, 1); // MI (1)
  assert.equal(metricas.diasConDosClases, 1); // MA (2)
  assert.equal(metricas.diasConcentrados, 1); // LU (3)
  assert.equal(metricas.maxClasesEnUnDia, 3);
  assert.equal(metricas.promedioClasesPorDiaActivo, 2);
  // 6/3 + (3 - 3) - 1.5*1 - 0.75*1 = 2 + 0 - 1.5 - 0.75 = -0.25
  assert.equal(metricas.indiceConcentracion, -0.25);
});

test("concentracionDiaria prefiere 2 días sobre 3 días, evita 1-2 clases/día y mantiene poda BnB exacta", () => {
  // Regresión del bug reportado: 4 materias donde cada una tiene opción de 2 días (MA/JU) o 3 días (LU/MI/VI).
  // Incluso con diasLibres=0 y concentracionDiaria alto (50), siempre debe preferirse 2 días [0,4,0,4,0,0] sobre 3 días [4,0,4,0,4,0].
  const mat2vs3 = [0, 1, 2, 3].map((idx) => {
    const ini = 420 + idx * 60;
    const fin = ini + 60;
    const clv = `C${idx}`;
    return {
      clave: clv,
      opciones: [
        crearRegistro({
          clv,
          grupo: "3DIAS",
          bloques: [
            ["LU", ini, fin],
            ["MI", ini, fin],
            ["VI", ini, fin],
          ],
        }),
        crearRegistro({
          clv,
          grupo: "2DIAS",
          bloques: [
            ["MA", ini, fin],
            ["JU", ini, fin],
          ],
        }),
      ],
    };
  });

  for (const wConc of [0, 8, 25, 50]) {
    const res = generarRecomendaciones(mat2vs3, {
      pesos: { ...PESOS_POR_DEFECTO, diasLibres: 0, concentracionDiaria: wConc },
      limiteResultados: 5,
    });
    assert.equal(res.recomendaciones[0].metricas.diasConClase, 2);
    assert.deepEqual(res.recomendaciones[0].metricas.clasesPorDia, {
      LU: 0,
      MA: 4,
      MI: 0,
      JU: 4,
      VI: 0,
      SA: 0,
    });
  }

  // Compara [3,3,3,1] (índice 0.0) vs [4,2,2,2] (índice -0.75) con iguales díasLibres=2, huecos=0 y fueraRango=0
  const materias = [
    { clave: "L1", opciones: [crearRegistro({ clv: "L1", grupo: "1", bloques: [["LU", 420, 480]] })] },
    { clave: "L2", opciones: [crearRegistro({ clv: "L2", grupo: "1", bloques: [["LU", 480, 540]] })] },
    { clave: "L3", opciones: [crearRegistro({ clv: "L3", grupo: "1", bloques: [["LU", 540, 600]] })] },
    { clave: "M1", opciones: [crearRegistro({ clv: "M1", grupo: "1", bloques: [["MA", 420, 480]] })] },
    { clave: "M2", opciones: [crearRegistro({ clv: "M2", grupo: "1", bloques: [["MA", 480, 540]] })] },
    { clave: "X1", opciones: [crearRegistro({ clv: "X1", grupo: "1", bloques: [["MI", 420, 480]] })] },
    { clave: "X2", opciones: [crearRegistro({ clv: "X2", grupo: "1", bloques: [["MI", 480, 540]] })] },
    { clave: "J1", opciones: [crearRegistro({ clv: "J1", grupo: "1", bloques: [["JU", 420, 480]] })] },
    {
      clave: "V1",
      opciones: [
        crearRegistro({
          clv: "V1",
          grupo: "FRAG",
          bloques: [
            ["LU", 600, 660], // LU -> 4
            ["JU", 480, 540], // JU -> 2  => [4,2,2,2]
          ],
        }),
        crearRegistro({
          clv: "V1",
          grupo: "CONC",
          bloques: [
            ["MA", 540, 600], // MA -> 3
            ["MI", 540, 600], // MI -> 3  => [3,3,3,1]
          ],
        }),
      ],
    },
  ];

  const conConcentracion = generarRecomendaciones(materias, {
    ...PRESETS_PREFERENCIAS.masDiasLibres,
  });
  assert.equal(conConcentracion.recomendaciones.length, 2);
  const mejor = conConcentracion.recomendaciones[0];
  const peor = conConcentracion.recomendaciones[1];
  assert.equal(mejor.registros[8].grupo, "CONC");
  assert.equal(peor.registros[8].grupo, "FRAG");
  assert.equal(mejor.metricas.indiceConcentracion, 0);
  assert.equal(peor.metricas.indiceConcentracion, -0.75);
  assert.equal(mejor.puntaje - peor.puntaje, 18.75); // (0 - (-0.75)) * 25

  // Con peso concentracionDiaria = 0 se desactiva la diferencia
  const desactivado = generarRecomendaciones(materias, {
    pesos: {
      diasLibres: 20,
      huecos: 10,
      rangoHorario: 10,
      concentracionDiaria: 0,
      solapamiento: 2,
    },
  });
  assert.equal(
    desactivado.recomendaciones[0].puntaje,
    desactivado.recomendaciones[1].puntaje
  );

  // Verifica exactitud de poda Branch-and-Bound frente a búsqueda exhaustiva en todos los presets
  const multi = [
    {
      clave: "A",
      opciones: [
        crearRegistro({ clv: "A", grupo: "1", bloques: [["LU", 420, 480], ["MI", 420, 480]] }),
        crearRegistro({ clv: "A", grupo: "2", bloques: [["LU", 420, 480], ["MA", 420, 480]] }),
        crearRegistro({ clv: "A", grupo: "3", bloques: [["VI", 900, 960], ["SA", 900, 960]] }),
      ],
    },
    {
      clave: "B",
      opciones: [
        crearRegistro({ clv: "B", grupo: "1", bloques: [["LU", 480, 540], ["MA", 480, 540]] }),
        crearRegistro({ clv: "B", grupo: "2", bloques: [["JU", 480, 540], ["VI", 480, 540]] }),
        crearRegistro({ clv: "B", grupo: "3", bloques: [["MI", 960, 1020], ["JU", 960, 1020]] }),
      ],
    },
    {
      clave: "C",
      opciones: [
        crearRegistro({ clv: "C", grupo: "1", bloques: [["LU", 540, 600], ["MA", 540, 600]] }),
        crearRegistro({ clv: "C", grupo: "2", bloques: [["MI", 540, 600], ["VI", 540, 600]] }),
        crearRegistro({ clv: "C", grupo: "3", bloques: [["JU", 1020, 1080], ["SA", 1020, 1080]] }),
      ],
    },
    {
      clave: "D",
      opciones: [
        crearRegistro({ clv: "D", grupo: "1", bloques: [["LU", 600, 660], ["MA", 600, 660]] }),
        crearRegistro({ clv: "D", grupo: "2", bloques: [["MI", 600, 660]] }),
        crearRegistro({ clv: "D", grupo: "3", bloques: [["VI", 1080, 1140], ["SA", 1080, 1140]] }),
      ],
    },
  ];

  for (const preset of [
    ...Object.values(PRESETS_PREFERENCIAS),
    { pesos: { ...PESOS_POR_DEFECTO, concentracionDiaria: 50 } },
  ]) {
    const top2 = generarRecomendaciones(multi, { ...preset, limiteResultados: 2 });
    const exhaustivo = generarRecomendaciones(multi, { ...preset, limiteResultados: 1000 });
    assert.deepEqual(
      top2.recomendaciones.map((r) => [r.id, r.puntaje]),
      exhaustivo.recomendaciones.slice(0, 2).map((r) => [r.id, r.puntaje])
    );
  }
});

test("todos los parámetros del motor (pesos, turno ideal, tolerancia, días y límite) funcionan correctamente", () => {
  // 1. peso diasLibres vs 0
  const mDias = [
    {
      clave: "D1",
      opciones: [
        crearRegistro({ clv: "D1", grupo: "LIBRE", bloques: [["LU", 420, 480]] }),
        crearRegistro({ clv: "D1", grupo: "EXTRA", bloques: [["MA", 420, 480]] }),
      ],
    },
    {
      clave: "D2",
      opciones: [crearRegistro({ clv: "D2", grupo: "BASE", bloques: [["LU", 480, 540]] })],
    },
  ];
  const prefLibres = generarRecomendaciones(mDias, {
    pesos: { diasLibres: 30, huecos: 0, rangoHorario: 0, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(prefLibres.recomendaciones[0].registros[0].grupo, "LIBRE");
  const sinDiasLibres = generarRecomendaciones(mDias, {
    pesos: { diasLibres: 0, huecos: 0, rangoHorario: 0, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(sinDiasLibres.recomendaciones[0].puntaje, sinDiasLibres.recomendaciones[1].puntaje);

  // 2. peso huecos vs 0
  const mHuecos = [
    {
      clave: "H1",
      opciones: [crearRegistro({ clv: "H1", grupo: "BASE", bloques: [["LU", 420, 480]] })],
    },
    {
      clave: "H2",
      opciones: [
        crearRegistro({ clv: "H2", grupo: "CON_HUECO", bloques: [["LU", 600, 660]] }), // 120m hueco
        crearRegistro({ clv: "H2", grupo: "SIN_HUECO", bloques: [["LU", 480, 540]] }), // 0m hueco
      ],
    },
  ];
  const prefHuecos = generarRecomendaciones(mHuecos, {
    pesos: { diasLibres: 0, huecos: 20, rangoHorario: 0, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(prefHuecos.recomendaciones[0].registros[1].grupo, "SIN_HUECO");
  assert.equal(prefHuecos.recomendaciones[0].puntaje - prefHuecos.recomendaciones[1].puntaje, 40);
  const sinHuecosPeso = generarRecomendaciones(mHuecos, {
    pesos: { diasLibres: 0, huecos: 0, rangoHorario: 0, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(sinHuecosPeso.recomendaciones[0].puntaje, sinHuecosPeso.recomendaciones[1].puntaje);

  // 3. rangoHorario + horaIdealInicioMin / horaIdealFinMin
  const mTurno = [
    {
      clave: "T1",
      opciones: [
        crearRegistro({ clv: "T1", grupo: "MAT", bloques: [["LU", 420, 540]] }), // 07-09
        crearRegistro({ clv: "T1", grupo: "VES", bloques: [["LU", 960, 1080]] }), // 16-18
      ],
    },
  ];
  const mat = generarRecomendaciones(mTurno, {
    horaIdealInicioMin: 420,
    horaIdealFinMin: 900,
    pesos: { diasLibres: 0, huecos: 0, rangoHorario: 25, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(mat.recomendaciones[0].registros[0].grupo, "MAT");
  const ves = generarRecomendaciones(mTurno, {
    horaIdealInicioMin: 840,
    horaIdealFinMin: 1320,
    pesos: { diasLibres: 0, huecos: 0, rangoHorario: 25, concentracionDiaria: 0, solapamiento: 0 },
  });
  assert.equal(ves.recomendaciones[0].registros[0].grupo, "VES");

  // 4. diasConsiderados restringe qué días cuentan como libres y para huecos
  const rSoloLuMa = generarRecomendaciones(
    [{ clave: "X", opciones: [crearRegistro({ clv: "X", grupo: "1", bloques: [["LU", 420, 480]] })] }],
    { diasConsiderados: ["LU", "MA"] }
  );
  assert.equal(rSoloLuMa.recomendaciones[0].metricas.diasLibres, 1);

  // 5. maxCombinacionesEvaluadas acota combinaciones y marca limiteAlcanzado
  const muchas = [0, 1, 2, 3].map((i) => ({
    clave: `M${i}`,
    opciones: [0, 1, 2].map((g) =>
      crearRegistro({
        clv: `M${i}`,
        grupo: `G${g}`,
        bloques: [["LU", 420 + i * 60, 480 + i * 60]],
      })
    ),
  }));
  const acotado = generarRecomendaciones(muchas, { maxCombinacionesEvaluadas: 5 });
  assert.equal(acotado.estadisticas.limiteAlcanzado, true);
  assert.equal(acotado.estadisticas.combinacionesEvaluadas, 5);
});

test("regresión real en data/sem_35_carr_12.json grupo 1307: aumentar concentracionDiaria no invierte 2 días a 3 días", (t) => {
  const ruta = path.join(ROOT_DIR, "data", "sem_35_carr_12.json");
  if (!fs.existsSync(ruta)) {
    t.skip("data/sem_35_carr_12.json aún no existe.");
    return;
  }
  const ds = JSON.parse(fs.readFileSync(ruta, "utf-8"));
  const g1307 = ds.horarios.filter((r) => r.grupo === "1307").slice(0, 4);
  if (g1307.length < 4) {
    t.skip("Grupo 1307 insuficiente.");
    return;
  }
  const entrada = g1307.map((r) => ({
    clave: r.clv_materia,
    materia: r.materia,
    opciones: ds.horarios.filter((o) => o.clv_materia === r.clv_materia),
  }));
  const r0 = generarRecomendaciones(entrada, {
    pesos: { ...PESOS_POR_DEFECTO, concentracionDiaria: 0 },
    limiteResultados: 5,
  });
  const r50 = generarRecomendaciones(entrada, {
    pesos: { ...PESOS_POR_DEFECTO, concentracionDiaria: 50 },
    limiteResultados: 5,
  });
  assert.equal(r0.recomendaciones[0].metricas.diasConClase, 2);
  assert.equal(r50.recomendaciones[0].metricas.diasConClase, 2);
});

test("preferenciaModalidad preferirEnLinea prioriza grupos a distancia/híbridos y conserva poda Branch-and-Bound exacta", () => {
  assert.equal(obtenerPesoEnLineaRegistro({ tipo_clase: "A DISTANCIA" }), 1);
  assert.equal(obtenerPesoEnLineaRegistro({ tipo_clase: "HÍBRIDO" }), 0.5);
  assert.equal(obtenerPesoEnLineaRegistro({ tipo_clase: "PRESENCIAL" }), 0);
  assert.equal(obtenerPesoEnLineaRegistro({ tipo_clase: "PRESENCIAL / A DISTANCIA" }), 0.5);

  const materias = [
    {
      clave: "M1",
      opciones: [
        {
          ...crearRegistro({ clv: "M1", grupo: "PRES", bloques: [["LU", 660, 780]] }), // 11:00-13:00 (0m hueco)
          tipo_clase: "PRESENCIAL",
        },
        {
          ...crearRegistro({ clv: "M1", grupo: "HIB", bloques: [["LU", 690, 810]] }), // 11:30-13:30 (30m hueco)
          tipo_clase: "HIBRIDO",
        },
        {
          ...crearRegistro({ clv: "M1", grupo: "LINEA", bloques: [["LU", 720, 840]] }), // 12:00-14:00 (60m hueco)
          tipo_clase: "A DISTANCIA",
        },
      ],
    },
    {
      clave: "M2",
      opciones: [
        {
          ...crearRegistro({ clv: "M2", grupo: "UNICO", bloques: [["LU", 540, 660]] }), // 09:00-11:00
          tipo_clase: "PRESENCIAL",
        },
      ],
    },
  ];

  // En modo indistinto, PRES gana por tener 0m de hueco
  const ind = generarRecomendaciones(materias, {
    preferenciaModalidad: "indistinto",
  });
  assert.equal(ind.recomendaciones[0].registros[0].grupo, "PRES");
  assert.equal(ind.recomendaciones[0].metricas.materiasEnLinea, 0);

  // Con preferirEnLinea, aunque M2 solo es presencial, se mantiene y elige LINEA > HIB > PRES
  const enLinea = generarRecomendaciones(materias, {
    preferenciaModalidad: "preferirEnLinea",
  });
  assert.equal(enLinea.recomendaciones.length, 3);
  assert.deepEqual(
    enLinea.recomendaciones.map((r) => r.registros[0].grupo),
    ["LINEA", "HIB", "PRES"]
  );
  assert.equal(enLinea.recomendaciones[0].metricas.materiasEnLinea, 1);
  assert.equal(enLinea.recomendaciones[1].metricas.materiasHibridas, 1);

  // Exactitud Branch-and-Bound con limiteResultados=1 vs exhaustivo
  const top1 = generarRecomendaciones(materias, {
    preferenciaModalidad: "preferirEnLinea",
    limiteResultados: 1,
  });
  assert.equal(top1.recomendaciones[0].id, enLinea.recomendaciones[0].id);
  assert.equal(top1.recomendaciones[0].puntaje, enLinea.recomendaciones[0].puntaje);

  // Incluso cuando el grupo en línea cae en otro día (y bajo masDiasLibres), preferirEnLinea lo promueve sobre presencial
  const otroDia = [
    {
      clave: "X1",
      opciones: [
        {
          ...crearRegistro({ clv: "X1", grupo: "PRES_MISMO_DIA", bloques: [["LU", 420, 540]] }),
          tipo_clase: "PRESENCIAL",
        },
        {
          ...crearRegistro({ clv: "X1", grupo: "LINEA_OTRO_DIA", bloques: [["MA", 420, 540]] }),
          tipo_clase: "A DISTANCIA",
        },
      ],
    },
    {
      clave: "X2",
      opciones: [
        {
          ...crearRegistro({ clv: "X2", grupo: "BASE", bloques: [["LU", 540, 660]] }),
          tipo_clase: "PRESENCIAL",
        },
      ],
    },
  ];
  const resOtroDia = generarRecomendaciones(otroDia, {
    ...PRESETS_PREFERENCIAS.masDiasLibres,
    preferenciaModalidad: "preferirEnLinea",
    limiteResultados: 1,
  });
  assert.equal(resOtroDia.recomendaciones[0].registros[0].grupo, "LINEA_OTRO_DIA");
});

test("preferirEnLinea modifica efectivamente las recomendaciones en datasets reales con oferta en línea", async (t) => {
  const rutaCivil = path.join(ROOT_DIR, "data", "sem_35_carr_10.json");
  const rutaCom = path.join(ROOT_DIR, "data", "sem_35_carr_4.json");
  const rutaComp = path.join(ROOT_DIR, "data", "sem_35_carr_12.json");
  if (!fs.existsSync(rutaCivil) || !fs.existsSync(rutaCom) || !fs.existsSync(rutaComp)) {
    t.skip("Datasets de prueba reales no disponibles.");
    return;
  }
  const { consolidarRegistrosPorGrupoMateria } = await import("../app.js");

  for (const [ruta, claves, opcionesBase] of [
    [rutaCivil, ["0205", "0219", "1024", "1091"], PRESETS_PREFERENCIAS.matutino],
    [rutaCom, ["1119", "1132", "1133", "1319"], {}],
    [rutaComp, ["1417", "1503", "1705"], PRESETS_PREFERENCIAS.vespertino],
  ]) {
    const ds = JSON.parse(fs.readFileSync(ruta, "utf-8"));
    const consolidados = consolidarRegistrosPorGrupoMateria(ds.horarios);
    const entrada = claves.map((clv) => ({
      clave: clv,
      materia: clv,
      opciones: consolidados.filter((r) => r.clv_materia === clv),
    }));
    const ind = generarRecomendaciones(entrada, {
      ...opcionesBase,
      preferenciaModalidad: "indistinto",
    });
    const enLinea = generarRecomendaciones(entrada, {
      ...opcionesBase,
      preferenciaModalidad: "preferirEnLinea",
    });
    assert.ok(ind.recomendaciones.length > 0 && enLinea.recomendaciones.length > 0);
    assert.ok(
      enLinea.recomendaciones[0].metricas.puntajeEnLineaRaw >
        ind.recomendaciones[0].metricas.puntajeEnLineaRaw,
      `Se esperaba mayor presencia en línea en ${path.basename(ruta)}`
    );
  }
});

test("materias en línea no penalizan días libres, concentración ni huecos presenciales pero sí detectan choques", () => {
  const pres1 = crearRegistro({
    clv: "P1",
    grupo: "1",
    bloques: [["LU", 420, 540]], // 07:00-09:00 presencial
  });
  const pres2 = crearRegistro({
    clv: "P2",
    grupo: "1",
    bloques: [["LU", 660, 780]], // 11:00-13:00 presencial (120m hueco con P1)
  });
  const onlineOtroDia = {
    ...crearRegistro({
      clv: "ON1",
      grupo: "1",
      bloques: [["SA", 420, 540]], // sábado en línea
    }),
    tipo_clase: "A DISTANCIA",
  };
  const onlineMismoDiaEntrePresenciales = {
    ...crearRegistro({
      clv: "ON2",
      grupo: "1",
      bloques: [["LU", 540, 660]], // 09:00-11:00 en línea entre P1 y P2
    }),
    tipo_clase: "A DISTANCIA",
  };

  assert.equal(esBloqueEnLinea({ dia: "SA" }, onlineOtroDia), true);
  assert.equal(esBloqueEnLinea({ dia: "LU" }, pres1), false);

  // Sábado en línea NO debe restar días libres ni contar como día suelto de 1 clase
  const mSabatina = calcularMetricasHorario([pres1, onlineOtroDia]);
  assert.equal(mSabatina.diasConClase, 1);
  assert.equal(mSabatina.diasLibres, 5);
  assert.equal(mSabatina.diasConUnaClase, 1); // solo LU (pres1), no SA
  assert.equal(mSabatina.clasesPorDia.SA, 0);

  // Clase en línea entre dos presenciales NO debe cerrar el hueco presencial en el plantel
  const mHuecoPresencial = calcularMetricasHorario([
    pres1,
    onlineMismoDiaEntrePresenciales,
    pres2,
  ]);
  assert.equal(mHuecoPresencial.totalHuecosMin, 120);
  assert.equal(mHuecoPresencial.clasesPorDia.LU, 2);

  // Sí debe detectar choque si coincide en horario con otra materia
  const onlineChoca = {
    ...crearRegistro({
      clv: "ON_CHQ",
      grupo: "1",
      bloques: [["LU", 480, 600]], // choca 60m con P1
    }),
    tipo_clase: "A DISTANCIA",
  };
  const mChoque = calcularMetricasHorario([pres1, onlineChoca]);
  assert.equal(mChoque.totalMinutosSolapamiento, 60);
  assert.equal(mChoque.totalChoques, 1);

  // Paridad exacta de Branch-and-Bound cuando hay opciones en línea en días distintos
  const entrada = [
    {
      clave: "P1",
      opciones: [pres1],
    },
    {
      clave: "M_MIX",
      opciones: [
        crearRegistro({ clv: "M_MIX", grupo: "PRES_MA", bloques: [["MA", 420, 540]] }),
        {
          ...crearRegistro({ clv: "M_MIX", grupo: "LINEA_VI", bloques: [["VI", 420, 540]] }),
          tipo_clase: "A DISTANCIA",
        },
        {
          ...crearRegistro({ clv: "M_MIX", grupo: "LINEA_CHOCA", bloques: [["LU", 450, 570]] }),
          tipo_clase: "A DISTANCIA",
        },
      ],
    },
  ];
  const top1 = generarRecomendaciones(entrada, {
    ...PRESETS_PREFERENCIAS.masDiasLibres,
    preferenciaModalidad: "preferirEnLinea",
    limiteResultados: 1,
  });
  const ex = generarRecomendaciones(entrada, {
    ...PRESETS_PREFERENCIAS.masDiasLibres,
    preferenciaModalidad: "preferirEnLinea",
    limiteResultados: 50,
  });
  assert.equal(top1.recomendaciones[0].registros[1].grupo, "LINEA_VI");
  assert.equal(top1.recomendaciones[0].metricas.diasLibres, 5);
  assert.equal(top1.recomendaciones[0].id, ex.recomendaciones[0].id);
  assert.equal(top1.recomendaciones[0].puntaje, ex.recomendaciones[0].puntaje);
});

test("detecta clases en línea por salón VIRTUAL aunque tipo_clase sea PRESENCIAL y excluye SINDEF", async (t) => {
  const virtualConTipoPresencial = {
    ...crearRegistro({ clv: "1417", grupo: "1407", bloques: [["SA", 420, 660]] }),
    salon: "VIRTUAL",
    tipo_clase: "PRESENCIAL",
  };
  const sindefPresencial = {
    ...crearRegistro({ clv: "1417", grupo: "1401", bloques: [["LU", 420, 540]] }),
    salon: "SINDEF",
    tipo_clase: "PRESENCIAL",
  };
  const mixtoSalon = {
    ...crearRegistro({
      clv: "1420",
      grupo: "1401",
      bloques: [
        ["LU", 420, 540],
        ["SA", 420, 540],
      ],
    }),
    salon: "A204 / VIRTUAL",
    tipo_clase: "PRESENCIAL",
  };
  const aDistancia = {
    ...crearRegistro({ clv: "1500", grupo: "1501", bloques: [["SA", 540, 660]] }),
    salon: "VIRTUAL",
    tipo_clase: "A DISTANCIA",
  };

  assert.equal(obtenerPesoEnLineaRegistro(virtualConTipoPresencial), 1);
  assert.equal(esBloqueEnLinea({ dia: "SA" }, virtualConTipoPresencial), true);
  assert.equal(obtenerEtiquetaModalidad(virtualConTipoPresencial), "EN LÍNEA");

  assert.equal(obtenerPesoEnLineaRegistro(sindefPresencial), 0);
  assert.equal(esBloqueEnLinea({ dia: "LU" }, sindefPresencial), false);
  assert.equal(obtenerEtiquetaModalidad(sindefPresencial), "PRESENCIAL");

  assert.equal(obtenerPesoEnLineaRegistro(mixtoSalon), 0.5);
  assert.equal(obtenerEtiquetaModalidad(mixtoSalon), "HÍBRIDO");

  assert.equal(obtenerPesoEnLineaRegistro(aDistancia), 1);
  assert.equal(obtenerEtiquetaModalidad(aDistancia), "A DISTANCIA");

  // Regresión real en Ingeniería en Computación (data/sem_35_carr_12.json)
  const rutaComp = path.join(ROOT_DIR, "data", "sem_35_carr_12.json");
  if (!fs.existsSync(rutaComp)) {
    t.skip("data/sem_35_carr_12.json no disponible.");
    return;
  }

  const { consolidarRegistrosPorGrupoMateria } = await import("../app.js");
  const ds = JSON.parse(fs.readFileSync(rutaComp, "utf-8"));
  const consolidados = consolidarRegistrosPorGrupoMateria(ds.horarios);

  const registrosEnLinea = consolidados.filter((r) => obtenerPesoEnLineaRegistro(r) > 0);
  const clavesEnLinea = new Set(registrosEnLinea.map((r) => r.clv_materia));
  assert.equal(registrosEnLinea.length, 19);
  assert.equal(clavesEnLinea.size, 11);
  for (const claveEsperada of ["1417", "1503", "1705", "1810", "8702"]) {
    assert.ok(clavesEnLinea.has(claveEsperada), `Debe detectar ${claveEsperada} en línea`);
  }

  // preferirEnLinea debe elegir grupos VIRTUAL en Computación y exentar el sábado de días presenciales
  const entradaComp = ["1417", "1503", "1705"].map((clv) => ({
    clave: clv,
    materia: clv,
    opciones: consolidados.filter((r) => r.clv_materia === clv),
  }));
  const resComp = generarRecomendaciones(entradaComp, {
    ...PRESETS_PREFERENCIAS.masDiasLibres,
    preferenciaModalidad: "preferirEnLinea",
  });
  assert.ok(resComp.recomendaciones.length > 0);
  const top = resComp.recomendaciones[0];
  assert.ok(top.metricas.materiasEnLinea > 0);
  assert.ok(
    top.registros.some((r) => r.salon === "VIRTUAL"),
    "La mejor recomendación debe incluir al menos un grupo VIRTUAL"
  );
  assert.equal(top.metricas.clasesPorDia.SA, 0);
});
