/**
 * Motor puro de validación de choques, generación de combinaciones sin traslapes
 * (o con tolerancia configurable en minutos), métricas semanales, puntaje
 * ponderado y diagnóstico de conflictos.
 *
 * No depende del DOM ni de APIs del navegador para mantenerse 100% testeable.
 */

export const DIAS_SEMANA = Object.freeze(["LU", "MA", "MI", "JU", "VI", "SA"]);

export const PESOS_POR_DEFECTO = Object.freeze({
  diasLibres: 20,
  huecos: 10,
  rangoHorario: 10,
  concentracionDiaria: 8,
  solapamiento: 2,
});

export const PRESETS_PREFERENCIAS = Object.freeze({
  balanceado: Object.freeze({
    id: "balanceado",
    nombre: "Balanceado",
    horaIdealInicioMin: 420, // 07:00
    horaIdealFinMin: 1320, // 22:00
    pesos: Object.freeze({ ...PESOS_POR_DEFECTO }),
  }),
  masDiasLibres: Object.freeze({
    id: "masDiasLibres",
    nombre: "Más días libres y concentrados",
    horaIdealInicioMin: 420,
    horaIdealFinMin: 1320,
    pesos: Object.freeze({
      diasLibres: 40,
      huecos: 8,
      rangoHorario: 5,
      concentracionDiaria: 25,
      solapamiento: 2,
    }),
  }),
  menosHuecos: Object.freeze({
    id: "menosHuecos",
    nombre: "Menos huecos",
    horaIdealInicioMin: 420,
    horaIdealFinMin: 1320,
    pesos: Object.freeze({
      diasLibres: 12,
      huecos: 30,
      rangoHorario: 8,
      concentracionDiaria: 6,
      solapamiento: 2,
    }),
  }),
  matutino: Object.freeze({
    id: "matutino",
    nombre: "Turno matutino",
    horaIdealInicioMin: 420, // 07:00
    horaIdealFinMin: 900, // 15:00
    pesos: Object.freeze({
      diasLibres: 15,
      huecos: 10,
      rangoHorario: 25,
      concentracionDiaria: 3,
      solapamiento: 2,
    }),
  }),
  vespertino: Object.freeze({
    id: "vespertino",
    nombre: "Turno vespertino",
    horaIdealInicioMin: 840, // 14:00
    horaIdealFinMin: 1320, // 22:00
    pesos: Object.freeze({
      diasLibres: 15,
      huecos: 10,
      rangoHorario: 25,
      concentracionDiaria: 3,
      solapamiento: 2,
    }),
  }),
});

const SET_DIAS_SEMANA = new Set(DIAS_SEMANA);
const PATRON_HORA = /^\d{1,2}:\d{2}$/;

function redondear2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte una hora "HH:MM" (o número finito de minutos) a minutos desde las 00:00.
 * Acepta hasta "24:00" (1440) para filtros o límites finales del día.
 */
export function horaAMinutos(valor) {
  if (typeof valor === "number") {
    return Number.isFinite(valor) && valor >= 0 && valor <= 1440 ? valor : null;
  }
  if (typeof valor !== "string") {
    return null;
  }

  const texto = valor.trim();
  if (!PATRON_HORA.test(texto)) {
    return null;
  }

  const [horasStr, minutosStr] = texto.split(":");
  const horas = Number(horasStr);
  const minutos = Number(minutosStr);

  if (horas === 24 && minutos === 0) {
    return 1440;
  }
  if (horas < 0 || horas > 23 || minutos < 0 || minutos > 59) {
    return null;
  }
  return horas * 60 + minutos;
}

/**
 * Formatea una cantidad de minutos desde las 00:00 como "HH:MM".
 */
export function minutosAHora(minutos) {
  if (!Number.isFinite(minutos) || minutos < 0 || minutos > 1440) {
    return "";
  }
  const redondeado = Math.round(minutos);
  const hh = String(Math.floor(redondeado / 60)).padStart(2, "0");
  const mm = String(redondeado % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Deduce el número de semestre a partir del código de grupo de FES Aragón.
 *
 * En claves de 4+ dígitos (p. ej. `1557` o `81101`), el 2° dígito de los últimos
 * 4 dígitos indica el semestre: `1`–`9` → 1°–9° semestre, y `0` → 10° / optativas.
 */
export function obtenerSemestreDeGrupo(grupo) {
  const digitos = String(grupo ?? "").replace(/\D/g, "");
  if (digitos.length < 4) {
    return null;
  }
  const ultimosCuatro = digitos.slice(-4);
  const segundoDigito = Number(ultimosCuatro[1]);
  return segundoDigito === 0 ? 10 : segundoDigito;
}

/**
 * Formatea un número de semestre de grupo (1..10) a etiqueta legible.
 */
export function formatearEtiquetaSemestre(semestreNum, corto = false) {
  if (semestreNum === 10) {
    return corto ? "10° / OPT" : "10° / Optativas";
  }
  if (Number.isInteger(semestreNum) && semestreNum >= 1 && semestreNum <= 9) {
    return corto ? `${semestreNum}° SEM` : `${semestreNum}° semestre`;
  }
  return corto ? "OTROS" : "Otros";
}

/**
 * Determina si un bloque horario es válido para cálculos de choque y duración.
 */
export function esBloqueValido(bloque) {
  return Boolean(
    bloque &&
      SET_DIAS_SEMANA.has(bloque.dia) &&
      Number.isFinite(bloque.inicio_min) &&
      Number.isFinite(bloque.fin_min) &&
      bloque.inicio_min >= 0 &&
      bloque.fin_min <= 1440 &&
      bloque.inicio_min < bloque.fin_min
  );
}

/**
 * Calcula los minutos de solapamiento entre dos bloques usando intervalos semiabiertos [inicio_min, fin_min).
 */
export function calcularSolapamientoBloques(bloqueA, bloqueB) {
  if (!esBloqueValido(bloqueA) || !esBloqueValido(bloqueB)) {
    return 0;
  }
  if (bloqueA.dia !== bloqueB.dia) {
    return 0;
  }

  const inicio = Math.max(bloqueA.inicio_min, bloqueB.inicio_min);
  const fin = Math.min(bloqueA.fin_min, bloqueB.fin_min);
  return fin > inicio ? fin - inicio : 0;
}

/**
 * Indica si dos bloques horarios colisionan (solapamiento > 0 minutos).
 */
export function hayColisionBloques(bloqueA, bloqueB) {
  return calcularSolapamientoBloques(bloqueA, bloqueB) > 0;
}

function obtenerBloquesValidos(registro) {
  if (!registro || !Array.isArray(registro.bloques)) {
    return [];
  }
  return registro.bloques.filter(esBloqueValido);
}

function calcularSolapamientoMinutosRegistros(bloquesA, bloquesB) {
  let total = 0;
  for (let i = 0; i < bloquesA.length; i += 1) {
    const ba = bloquesA[i];
    for (let j = 0; j < bloquesB.length; j += 1) {
      const bb = bloquesB[j];
      if (ba.dia === bb.dia) {
        const inicio = Math.max(ba.inicio_min, bb.inicio_min);
        const fin = Math.min(ba.fin_min, bb.fin_min);
        if (fin > inicio) {
          total += fin - inicio;
        }
      }
    }
  }
  return total;
}

/**
 * Devuelve todos los choques detallados entre dos registros de asignaturas/grupos.
 */
export function detectarSolapamientosEntreRegistros(regA, regB) {
  const bloquesA = obtenerBloquesValidos(regA);
  const bloquesB = obtenerBloquesValidos(regB);
  const choques = [];

  for (const bloqueA of bloquesA) {
    for (const bloqueB of bloquesB) {
      const minutos = calcularSolapamientoBloques(bloqueA, bloqueB);
      if (minutos > 0) {
        const inicio_min = Math.max(bloqueA.inicio_min, bloqueB.inicio_min);
        const fin_min = Math.min(bloqueA.fin_min, bloqueB.fin_min);
        choques.push({
          dia: bloqueA.dia,
          inicio_min,
          fin_min,
          hora_texto: `${minutosAHora(inicio_min)}-${minutosAHora(fin_min)}`,
          minutos,
          idA: regA.id ?? null,
          clvMateriaA: regA.clv_materia ?? "",
          materiaA: regA.materia ?? "",
          grupoA: regA.grupo ?? "",
          idB: regB.id ?? null,
          clvMateriaB: regB.clv_materia ?? "",
          materiaB: regB.materia ?? "",
          grupoB: regB.grupo ?? "",
        });
      }
    }
  }

  return choques;
}

/**
 * Analiza un horario completo detectando todos los choques y bloques irregulares.
 */
export function detectarSolapamientosHorario(registros = []) {
  const lista = Array.isArray(registros) ? registros : [];
  const solapamientos = [];
  const bloquesIrregulares = [];
  const advertencias = [];
  let totalMinutosSolapamiento = 0;

  for (let i = 0; i < lista.length; i += 1) {
    const reg = lista[i];
    if (reg && Array.isArray(reg.bloques)) {
      for (const bloque of reg.bloques) {
        if (!esBloqueValido(bloque)) {
          bloquesIrregulares.push({
            id: reg.id ?? null,
            clv_materia: reg.clv_materia ?? "",
            materia: reg.materia ?? "",
            grupo: reg.grupo ?? "",
            dia: bloque?.dia ?? "",
            hora_texto: bloque?.hora_texto ?? "",
          });
          advertencias.push(
            `Bloque horario irregular en ${reg.materia || reg.clv_materia} (grupo ${reg.grupo || "?"}): ${bloque?.dia || "?"} ${bloque?.hora_texto || "sin hora"}.`
          );
        }
      }
    }

    for (let j = i + 1; j < lista.length; j += 1) {
      const choques = detectarSolapamientosEntreRegistros(lista[i], lista[j]);
      for (const choque of choques) {
        solapamientos.push(choque);
        totalMinutosSolapamiento += choque.minutos;
        advertencias.push(
          `Solapamiento de ${choque.minutos} min el ${choque.dia} (${choque.hora_texto}) entre ${choque.materiaA || choque.clvMateriaA} (${choque.grupoA}) y ${choque.materiaB || choque.clvMateriaB} (${choque.grupoB}).`
        );
      }
    }
  }

  return {
    solapamientos,
    totalMinutosSolapamiento,
    totalChoques: solapamientos.length,
    tieneSolapamiento: solapamientos.length > 0,
    bloquesIrregulares,
    advertencias,
  };
}

function normalizarRangoIdeal(opciones = {}) {
  const rawInicio = horaAMinutos(opciones.horaIdealInicioMin ?? 420) ?? 420;
  const rawFin = horaAMinutos(opciones.horaIdealFinMin ?? 1320) ?? 1320;
  return {
    horaIdealInicioMin: Math.min(rawInicio, rawFin),
    horaIdealFinMin: Math.max(rawInicio, rawFin),
  };
}

function calcularHuecosDia(bloquesDia) {
  if (!bloquesDia || bloquesDia.length < 2) {
    return 0;
  }
  const ordenados = [...bloquesDia].sort(
    (a, b) => a.inicio_min - b.inicio_min || a.fin_min - b.fin_min
  );

  // Fusiona bloques solapados o adyacentes antes de sumar huecos entre clases
  let finActual = ordenados[0].fin_min;
  let huecos = 0;

  for (let i = 1; i < ordenados.length; i += 1) {
    const actual = ordenados[i];
    if (actual.inicio_min <= finActual) {
      if (actual.fin_min > finActual) {
        finActual = actual.fin_min;
      }
    } else {
      huecos += actual.inicio_min - finActual;
      finActual = actual.fin_min;
    }
  }
  return huecos;
}

function contarBits(mascara) {
  let n = mascara | 0;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count += 1;
  }
  return count;
}

/**
 * Calcula un índice semanal de concentración diaria que:
 * - Premia mayor promedio de materias por día activo (`totalSesiones / diasConClase`).
 * - Premia usar menos días totales (`3 - diasConClase`), garantizando que 2 días siempre
 *   superen a 3 días a igualdad o mejor carga diaria (p. ej. [4,4] > [4,4,4]).
 * - Penaliza cada día suelto con 1 clase (-1.5) o 2 clases (-0.75).
 */
export function calcularIndiceConcentracion(conteosPorDia = []) {
  let diasConClase = 0;
  let totalSesiones = 0;
  let diasConUnaClase = 0;
  let diasConDosClases = 0;

  for (let i = 0; i < conteosPorDia.length; i += 1) {
    const c = Number(conteosPorDia[i]) || 0;
    if (c <= 0) {
      continue;
    }
    diasConClase += 1;
    totalSesiones += c;
    if (c === 1) {
      diasConUnaClase += 1;
    } else if (c === 2) {
      diasConDosClases += 1;
    }
  }

  if (diasConClase === 0) {
    return 0;
  }

  return redondear2(
    totalSesiones / diasConClase +
      (3 - diasConClase) -
      1.5 * diasConUnaClase -
      0.75 * diasConDosClases
  );
}

/**
 * Calcula las métricas semanales de un horario completo (RF-REC-03).
 *
 * Para evitar huecos negativos o distorsionados cuando existen solapamientos,
 * los bloques válidos de cada día se fusionan en intervalos unidos antes de medir huecos.
 */
export function calcularMetricasHorario(registros = [], opciones = {}) {
  const lista = Array.isArray(registros) ? registros : [];
  const { horaIdealInicioMin, horaIdealFinMin } = normalizarRangoIdeal(opciones);
  const diasConsiderados =
    Array.isArray(opciones.diasConsiderados) && opciones.diasConsiderados.length > 0
      ? opciones.diasConsiderados.filter((d) => SET_DIAS_SEMANA.has(d))
      : DIAS_SEMANA;

  const bloquesPorDia = new Map(diasConsiderados.map((dia) => [dia, []]));
  const materiasPorDia = new Map(diasConsiderados.map((dia) => [dia, 0]));
  let totalMinutosClase = 0;
  let minutosFueraRango = 0;
  let horaPrimeraClaseMin = null;
  let horaUltimaClaseMin = null;

  for (const registro of lista) {
    const diasRegistro = new Set();
    for (const bloque of obtenerBloquesValidos(registro)) {
      if (bloquesPorDia.has(bloque.dia)) {
        bloquesPorDia.get(bloque.dia).push(bloque);
        diasRegistro.add(bloque.dia);
      }

      const duracion = bloque.fin_min - bloque.inicio_min;
      totalMinutosClase += duracion;

      if (horaPrimeraClaseMin === null || bloque.inicio_min < horaPrimeraClaseMin) {
        horaPrimeraClaseMin = bloque.inicio_min;
      }
      if (horaUltimaClaseMin === null || bloque.fin_min > horaUltimaClaseMin) {
        horaUltimaClaseMin = bloque.fin_min;
      }

      const dentroRango = Math.max(
        0,
        Math.min(bloque.fin_min, horaIdealFinMin) -
          Math.max(bloque.inicio_min, horaIdealInicioMin)
      );
      minutosFueraRango += duracion - dentroRango;
    }

    for (const diaReg of diasRegistro) {
      materiasPorDia.set(diaReg, (materiasPorDia.get(diaReg) || 0) + 1);
    }
  }

  let diasConClase = 0;
  let diasLibres = 0;
  let totalHuecosMin = 0;
  let diasConPocasClases = 0;
  let diasConUnaClase = 0;
  let diasConDosClases = 0;
  let diasConcentrados = 0;
  let maxClasesEnUnDia = 0;
  let totalSesionesDia = 0;
  const listaDiasLibres = [];
  const clasesPorDia = {};

  for (const dia of diasConsiderados) {
    const bloquesDia = bloquesPorDia.get(dia) || [];
    const clasesDia = materiasPorDia.get(dia) || 0;
    clasesPorDia[dia] = clasesDia;

    if (bloquesDia.length === 0) {
      diasLibres += 1;
      listaDiasLibres.push(dia);
      continue;
    }

    diasConClase += 1;
    totalHuecosMin += calcularHuecosDia(bloquesDia);
    totalSesionesDia += clasesDia;
    if (clasesDia <= 2) {
      diasConPocasClases += 1;
    }
    if (clasesDia === 1) {
      diasConUnaClase += 1;
    } else if (clasesDia === 2) {
      diasConDosClases += 1;
    }
    if (clasesDia >= 3) {
      diasConcentrados += 1;
    }
    if (clasesDia > maxClasesEnUnDia) {
      maxClasesEnUnDia = clasesDia;
    }
  }

  const promedioClasesPorDiaActivo =
    diasConClase > 0 ? redondear2(totalSesionesDia / diasConClase) : 0;
  const indiceConcentracion = calcularIndiceConcentracion(
    diasConsiderados.map((d) => clasesPorDia[d])
  );

  const resumenSolapamientos =
    opciones.resumenSolapamientos || detectarSolapamientosHorario(lista);

  return {
    diasConClase,
    diasLibres,
    listaDiasLibres,
    clasesPorDia,
    diasConPocasClases,
    diasConUnaClase,
    diasConDosClases,
    diasConcentrados,
    maxClasesEnUnDia,
    promedioClasesPorDiaActivo,
    indiceConcentracion,
    totalHuecosMin,
    minutosFueraRango,
    totalMinutosClase,
    horaPrimeraClaseMin,
    horaUltimaClaseMin,
    totalMinutosSolapamiento: resumenSolapamientos.totalMinutosSolapamiento,
    totalChoques: resumenSolapamientos.totalChoques,
    bloquesIrregulares: resumenSolapamientos.bloquesIrregulares.length,
  };
}

/**
 * Calcula un puntaje ponderado a partir de las métricas del horario (RF-REC-04).
 */
export function calcularPuntaje(metricas, pesos = PESOS_POR_DEFECTO) {
  const w = {
    diasLibres: Number.isFinite(Number(pesos?.diasLibres))
      ? Number(pesos.diasLibres)
      : PESOS_POR_DEFECTO.diasLibres,
    huecos: Number.isFinite(Number(pesos?.huecos))
      ? Number(pesos.huecos)
      : PESOS_POR_DEFECTO.huecos,
    rangoHorario: Number.isFinite(Number(pesos?.rangoHorario))
      ? Number(pesos.rangoHorario)
      : PESOS_POR_DEFECTO.rangoHorario,
    concentracionDiaria: Number.isFinite(Number(pesos?.concentracionDiaria))
      ? Number(pesos.concentracionDiaria)
      : PESOS_POR_DEFECTO.concentracionDiaria,
    solapamiento: Number.isFinite(Number(pesos?.solapamiento))
      ? Number(pesos.solapamiento)
      : PESOS_POR_DEFECTO.solapamiento,
  };

  const base = 100;
  const bonoDiasLibres = metricas.diasLibres * w.diasLibres;
  const penalizacionHuecos = (metricas.totalHuecosMin / 60) * w.huecos;
  const penalizacionRango = (metricas.minutosFueraRango / 60) * w.rangoHorario;
  const indiceConcentracion = Number.isFinite(Number(metricas?.indiceConcentracion))
    ? Number(metricas.indiceConcentracion)
    : 0;
  const ajusteConcentracion = indiceConcentracion * w.concentracionDiaria;
  const penalizacionSolapamiento =
    metricas.totalMinutosSolapamiento * w.solapamiento;

  const puntaje = redondear2(
    base +
      bonoDiasLibres +
      ajusteConcentracion -
      penalizacionHuecos -
      penalizacionRango -
      penalizacionSolapamiento
  );

  return {
    puntaje,
    desglose: {
      base,
      diasLibres: redondear2(bonoDiasLibres),
      concentracionDiaria: redondear2(ajusteConcentracion),
      huecos: redondear2(-penalizacionHuecos),
      rangoHorario: redondear2(-penalizacionRango),
      solapamiento: redondear2(-penalizacionSolapamiento),
    },
  };
}

function normalizarToleranciaSolapamiento(opciones = {}) {
  if (!opciones.permitirSolapamiento) {
    return 0;
  }
  const raw = opciones.toleranciaSolapamientoMin;
  if (raw === null || raw === undefined || raw === "" || raw === Infinity) {
    return Infinity;
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return num;
}

function normalizarMateriasEntrada(materiasSeleccionadas = []) {
  if (!Array.isArray(materiasSeleccionadas)) {
    return [];
  }
  return materiasSeleccionadas.map((item, idx) => {
    if (Array.isArray(item)) {
      const primero = item[0] || {};
      return {
        indiceOriginal: idx,
        clave: primero.clv_materia || `MATERIA_${idx + 1}`,
        materia: primero.materia || primero.clv_materia || `Materia ${idx + 1}`,
        opciones: item,
      };
    }
    const opciones = Array.isArray(item?.opciones) ? item.opciones : [];
    const primero = opciones[0] || {};
    return {
      indiceOriginal: idx,
      clave: item?.clave ?? primero.clv_materia ?? `MATERIA_${idx + 1}`,
      materia:
        item?.materia ?? primero.materia ?? item?.clave ?? `Materia ${idx + 1}`,
      opciones,
    };
  });
}

function construirFirmaRegistros(registros) {
  return registros
    .map((r) => r.id || `${r.clv_materia || ""}:${r.grupo || ""}`)
    .join("|");
}

/**
 * Comparador determinista de recomendaciones: mayor puntaje primero y desempate estable.
 */
export function compararRecomendaciones(a, b) {
  if (b.puntaje !== a.puntaje) {
    return b.puntaje - a.puntaje;
  }
  if (
    a.metricas.totalMinutosSolapamiento !== b.metricas.totalMinutosSolapamiento
  ) {
    return (
      a.metricas.totalMinutosSolapamiento - b.metricas.totalMinutosSolapamiento
    );
  }
  if (b.metricas.diasLibres !== a.metricas.diasLibres) {
    return b.metricas.diasLibres - a.metricas.diasLibres;
  }
  if (a.metricas.totalHuecosMin !== b.metricas.totalHuecosMin) {
    return a.metricas.totalHuecosMin - b.metricas.totalHuecosMin;
  }
  if (a.metricas.minutosFueraRango !== b.metricas.minutosFueraRango) {
    return a.metricas.minutosFueraRango - b.metricas.minutosFueraRango;
  }
  const concA = a.metricas.indiceConcentracion ?? 0;
  const concB = b.metricas.indiceConcentracion ?? 0;
  if (concB !== concA) {
    return concB - concA;
  }
  const firmaA = a._firma ?? construirFirmaRegistros(a.registros);
  const firmaB = b._firma ?? construirFirmaRegistros(b.registros);
  return firmaA.localeCompare(firmaB);
}

function insertarEnTopOrdenado(lista, candidato, limite) {
  if (limite <= 0) {
    return;
  }
  if (
    lista.length >= limite &&
    compararRecomendaciones(candidato, lista[lista.length - 1]) >= 0
  ) {
    return;
  }

  // Búsqueda binaria de inserción manteniendo orden ascendente de prioridad
  let izq = 0;
  let der = lista.length;
  while (izq < der) {
    const mid = (izq + der) >> 1;
    if (compararRecomendaciones(candidato, lista[mid]) < 0) {
      der = mid;
    } else {
      izq = mid + 1;
    }
  }
  lista.splice(izq, 0, candidato);

  if (lista.length > limite) {
    lista.pop();
  }
}

/**
 * Analiza por qué no fue posible armar un horario válido y sugiere ajustes concretos (RF-REC-05).
 */
export function diagnosticarConflictos(materiasSeleccionadas = [], opciones = {}) {
  const materias = normalizarMateriasEntrada(materiasSeleccionadas);
  const toleranciaEfectivaMin = normalizarToleranciaSolapamiento(opciones);

  const materiasSinOpciones = materias
    .filter((m) => m.opciones.length === 0)
    .map((m) => ({ clave: m.clave, materia: m.materia }));

  const materiasConOpciones = materias.filter((m) => m.opciones.length > 0);
  const bloquesCache = materiasConOpciones.map((m) =>
    m.opciones.map((op) => obtenerBloquesValidos(op))
  );

  const paresIncompatibles = [];
  let maxSolapamientoMinimoRequerido = 0;

  for (let i = 0; i < materiasConOpciones.length; i += 1) {
    for (let j = i + 1; j < materiasConOpciones.length; j += 1) {
      let minOverlap = Infinity;
      for (const bA of bloquesCache[i]) {
        for (const bB of bloquesCache[j]) {
          const ov = calcularSolapamientoMinutosRegistros(bA, bB);
          if (ov < minOverlap) {
            minOverlap = ov;
          }
          if (minOverlap === 0) {
            break;
          }
        }
        if (minOverlap === 0) {
          break;
        }
      }

      if (minOverlap > toleranciaEfectivaMin) {
        paresIncompatibles.push({
          claveA: materiasConOpciones[i].clave,
          materiaA: materiasConOpciones[i].materia,
          claveB: materiasConOpciones[j].clave,
          materiaB: materiasConOpciones[j].materia,
          solapamientoMinimoMin: minOverlap,
        });
        if (minOverlap > maxSolapamientoMinimoRequerido) {
          maxSolapamientoMinimoRequerido = minOverlap;
        }
      }
    }
  }

  let conflictoMultiple = null;
  if (
    materiasSinOpciones.length === 0 &&
    paresIncompatibles.length === 0 &&
    materiasConOpciones.length > 2
  ) {
    // Encuentra el subconjunto máximo de materias que sí conviven juntas
    let mejorIndices = [];
    const n = materiasConOpciones.length;
    const seleccion = [];
    const indicesElegidos = [];
    let nodos = 0;
    const maxNodosDiagnostico = 15000;

    const buscarSubconjunto = (idx, solapAcum) => {
      if (nodos >= maxNodosDiagnostico) {
        return;
      }
      nodos += 1;

      if (indicesElegidos.length > mejorIndices.length) {
        mejorIndices = [...indicesElegidos];
      }
      if (indicesElegidos.length + (n - idx) <= mejorIndices.length) {
        return;
      }
      if (idx >= n) {
        return;
      }

      // Intenta incluir la materia actual con cualquiera de sus grupos
      for (let g = 0; g < bloquesCache[idx].length; g += 1) {
        const bloquesNuevo = bloquesCache[idx][g];
        let delta = 0;
        let excede = false;
        for (let k = 0; k < seleccion.length; k += 1) {
          delta += calcularSolapamientoMinutosRegistros(
            seleccion[k],
            bloquesNuevo
          );
          if (solapAcum + delta > toleranciaEfectivaMin) {
            excede = true;
            break;
          }
        }
        if (!excede) {
          seleccion.push(bloquesNuevo);
          indicesElegidos.push(idx);
          buscarSubconjunto(idx + 1, solapAcum + delta);
          indicesElegidos.pop();
          seleccion.pop();
          if (mejorIndices.length === n || nodos >= maxNodosDiagnostico) {
            return;
          }
        }
      }

      // O bien omitirla para medir compatibilidad del resto
      buscarSubconjunto(idx + 1, solapAcum);
    };

    buscarSubconjunto(0, 0);

    const setMejor = new Set(mejorIndices);
    const materiasConflictivas = materiasConOpciones
      .filter((_, idx) => !setMejor.has(idx))
      .map((m) => ({ clave: m.clave, materia: m.materia }));

    if (materiasConflictivas.length > 0) {
      conflictoMultiple = {
        maxMateriasCompatibles: mejorIndices.length,
        materiasConflictivas,
      };
    }
  }

  // Estima el mínimo traslape total necesario para acomodar TODAS las materias juntas
  let toleranciaMinimaSugerida = maxSolapamientoMinimoRequerido;
  if (
    materiasSinOpciones.length === 0 &&
    materiasConOpciones.length > 1 &&
    materiasConOpciones.length <= 10
  ) {
    const bloquesOrdenados = [...bloquesCache].sort((a, b) => a.length - b.length);
    const nDiag = bloquesOrdenados.length;
    const selDiag = new Array(nDiag);
    let mejorSolapTotal = Infinity;
    let nodosDiag = 0;
    const maxNodosMin = 20000;

    const buscarMinSolap = (nivel, solapAcum) => {
      if (solapAcum >= mejorSolapTotal || nodosDiag >= maxNodosMin) {
        return;
      }
      if (nivel === nDiag) {
        mejorSolapTotal = solapAcum;
        return;
      }
      const opts = bloquesOrdenados[nivel];
      // Ordena opciones locales por menor choque incremental contra lo ya elegido
      const candidatos = opts
        .map((b, idx) => {
          let delta = 0;
          for (let prev = 0; prev < nivel; prev += 1) {
            delta += calcularSolapamientoMinutosRegistros(selDiag[prev], b);
          }
          return { idx, b, delta };
        })
        .sort((a, b) => a.delta - b.delta);

      for (const cand of candidatos) {
        nodosDiag += 1;
        if (nodosDiag > maxNodosMin) {
          return;
        }
        if (solapAcum + cand.delta >= mejorSolapTotal) {
          break;
        }
        selDiag[nivel] = cand.b;
        buscarMinSolap(nivel + 1, solapAcum + cand.delta);
      }
    };

    buscarMinSolap(0, 0);
    if (Number.isFinite(mejorSolapTotal) && mejorSolapTotal > toleranciaEfectivaMin) {
      toleranciaMinimaSugerida = mejorSolapTotal;
    }
  }

  const sugerencias = [];

  if (materiasSinOpciones.length > 0) {
    const nombres = materiasSinOpciones
      .map((m) => `${m.materia} (${m.clave})`)
      .join(", ");
    sugerencias.push(
      `Las siguientes materias no tienen grupos disponibles con los filtros actuales: ${nombres}. Amplía el rango horario, días permitidos, cupo o profesores excluidos.`
    );
  }

  if (paresIncompatibles.length > 0) {
    for (const par of paresIncompatibles) {
      sugerencias.push(
        `Conflicto directo entre ${par.materiaA} (${par.claveA}) y ${par.materiaB} (${par.claveB}): su menor traslape posible es de ${par.solapamientoMinimoMin} min.`
      );
    }
    if (!opciones.permitirSolapamiento || toleranciaMinimaSugerida > toleranciaEfectivaMin) {
      sugerencias.push(
        `Puedes quitar una de esas materias, relajar los filtros de grupo/profesor, o activar la tolerancia de solapamiento con al menos ${toleranciaMinimaSugerida} minutos.`
      );
    }
  }

  if (conflictoMultiple) {
    const nombres = conflictoMultiple.materiasConflictivas
      .map((m) => `${m.materia} (${m.clave})`)
      .join(", ");
    const textoTol =
      toleranciaMinimaSugerida > toleranciaEfectivaMin
        ? ` o activa la tolerancia de solapamiento con al menos ${toleranciaMinimaSugerida} minutos`
        : " o incrementa la tolerancia de solapamiento";
    sugerencias.push(
      `Todas las materias combinan en pares, pero no logran acoplarse todas a la vez (máximo ${conflictoMultiple.maxMateriasCompatibles} compatibles). Revisa o sustituye: ${nombres}${textoTol}.`
    );
  }

  if (sugerencias.length === 0 && materias.length > 0) {
    sugerencias.push(
      "Se alcanzó el límite de evaluación antes de hallar una combinación válida. Prueba reducir la cantidad de materias o ajustar los filtros."
    );
  }

  return {
    tieneConflictos: true,
    toleranciaEfectivaMin,
    toleranciaMinimaSugerida,
    materiasSinOpciones,
    paresIncompatibles,
    conflictoMultiple,
    sugerencias,
  };
}

/**
 * Genera y ordena combinaciones válidas mediante backtracking con ordenamiento por
 * preferencias y poda exacta Branch-and-Bound (RF-REC-02, RF-REC-04).
 *
 * Permite 0 traslapes por defecto, o cualquier cantidad de choques cuando
 * `permitirSolapamiento` es true siempre que los minutos totales traslapados
 * no superen `toleranciaSolapamientoMin` (o sin límite si es null/Infinity).
 */
export function generarRecomendaciones(
  materiasSeleccionadas = [],
  opciones = {}
) {
  const inicioMs = Date.now();
  const materias = normalizarMateriasEntrada(materiasSeleccionadas);
  const toleranciaEfectivaMin = normalizarToleranciaSolapamiento(opciones);
  const maxCombinacionesEvaluadas = Math.max(
    1,
    Number(opciones.maxCombinacionesEvaluadas) || 25000
  );
  const limiteResultados = Math.max(
    1,
    Number(opciones.limiteResultados) || 20
  );
  const rawPesos = opciones.pesos ?? PESOS_POR_DEFECTO;
  const pesos = {
    diasLibres: Number.isFinite(Number(rawPesos?.diasLibres))
      ? Number(rawPesos.diasLibres)
      : PESOS_POR_DEFECTO.diasLibres,
    huecos: Number.isFinite(Number(rawPesos?.huecos))
      ? Number(rawPesos.huecos)
      : PESOS_POR_DEFECTO.huecos,
    rangoHorario: Number.isFinite(Number(rawPesos?.rangoHorario))
      ? Number(rawPesos.rangoHorario)
      : PESOS_POR_DEFECTO.rangoHorario,
    concentracionDiaria: Number.isFinite(Number(rawPesos?.concentracionDiaria))
      ? Number(rawPesos.concentracionDiaria)
      : PESOS_POR_DEFECTO.concentracionDiaria,
    solapamiento: Number.isFinite(Number(rawPesos?.solapamiento))
      ? Number(rawPesos.solapamiento)
      : PESOS_POR_DEFECTO.solapamiento,
  };
  const { horaIdealInicioMin, horaIdealFinMin } = normalizarRangoIdeal(opciones);
  const diasConsiderados =
    Array.isArray(opciones.diasConsiderados) && opciones.diasConsiderados.length > 0
      ? opciones.diasConsiderados.filter((d) => SET_DIAS_SEMANA.has(d))
      : DIAS_SEMANA;
  const numDias = diasConsiderados.length;
  const diaIndiceMap = new Map(diasConsiderados.map((d, idx) => [d, idx]));

  if (materias.length === 0) {
    return {
      recomendaciones: [],
      estadisticas: {
        combinacionesEvaluadas: 0,
        combinacionesValidas: 0,
        nodosExplorados: 0,
        podasPorCota: 0,
        limiteAlcanzado: false,
        tiempoMs: Date.now() - inicioMs,
        toleranciaEfectivaMin,
      },
      diagnostico: null,
    };
  }

  const algunaSinOpciones = materias.some((m) => m.opciones.length === 0);
  if (algunaSinOpciones) {
    return {
      recomendaciones: [],
      estadisticas: {
        combinacionesEvaluadas: 0,
        combinacionesValidas: 0,
        nodosExplorados: 0,
        podasPorCota: 0,
        limiteAlcanzado: false,
        tiempoMs: Date.now() - inicioMs,
        toleranciaEfectivaMin,
      },
      diagnostico: diagnosticarConflictos(materias, opciones),
    };
  }

  // Precalcula métricas individuales por opción y ordena cada materia según las preferencias
  const materiasPreparadas = materias.map((m) => {
    const opcionesConInfo = m.opciones.map((registro) => {
      const bloques = obtenerBloquesValidos(registro);
      const porDia = Array.from({ length: numDias }, () => []);
      let diasMask = 0;
      let fueraRangoMin = 0;

      for (const b of bloques) {
        const idxDia = diaIndiceMap.get(b.dia);
        if (idxDia !== undefined) {
          porDia[idxDia].push(b);
          diasMask |= 1 << idxDia;
        }
        const dur = b.fin_min - b.inicio_min;
        const dentro = Math.max(
          0,
          Math.min(b.fin_min, horaIdealFinMin) -
            Math.max(b.inicio_min, horaIdealInicioMin)
        );
        fueraRangoMin += dur - dentro;
      }

      let huecosPropiosMin = 0;
      for (let d = 0; d < numDias; d += 1) {
        if (porDia[d].length >= 2) {
          huecosPropiosMin += calcularHuecosDia(porDia[d]);
        }
      }

      const costoOrden =
        (fueraRangoMin / 60) * Math.max(0, pesos.rangoHorario) +
        (huecosPropiosMin / 60) * Math.max(0, pesos.huecos) +
        contarBits(diasMask) * Math.max(0, pesos.diasLibres) * 0.25 +
        contarBits(diasMask) * Math.max(0, pesos.concentracionDiaria) * 0.2;

      const firma = registro.id || `${registro.clv_materia || ""}:${registro.grupo || ""}`;

      return {
        registro,
        bloques,
        porDia,
        diasMask,
        fueraRangoMin,
        costoOrden,
        firma,
      };
    });

    opcionesConInfo.sort(
      (a, b) => a.costoOrden - b.costoOrden || a.firma.localeCompare(b.firma)
    );

    return {
      ...m,
      opcionesInfo: opcionesConInfo,
    };
  });

  // Ordena materias de menor a mayor número de grupos (heurística MRV para podar antes)
  const ordenadas = [...materiasPreparadas].sort(
    (a, b) =>
      a.opcionesInfo.length - b.opcionesInfo.length ||
      a.indiceOriginal - b.indiceOriginal
  );

  // Caché de solapamientos entre pares específicos (nivelA, idxA, nivelB, idxB)
  const cacheSolapamientos = new Map();
  const obtenerSolapamientoCached = (nivA, idxA, nivB, idxB) => {
    const llave = `${nivA}:${idxA}-${nivB}:${idxB}`;
    if (cacheSolapamientos.has(llave)) {
      return cacheSolapamientos.get(llave);
    }
    const mins = calcularSolapamientoMinutosRegistros(
      ordenadas[nivA].opcionesInfo[idxA].bloques,
      ordenadas[nivB].opcionesInfo[idxB].bloques
    );
    cacheSolapamientos.set(llave, mins);
    return mins;
  };

  const puedePodarPorCota =
    pesos.diasLibres >= 0 &&
    pesos.huecos >= 0 &&
    pesos.rangoHorario >= 0 &&
    pesos.concentracionDiaria >= 0 &&
    pesos.solapamiento >= 0;

  const n = ordenadas.length;
  // Máximo de materias adicionales que pueden caer en cada día a partir de `nivel`
  const restantesPorDia = Array.from({ length: n + 1 }, () => new Int32Array(numDias));
  for (let nivel = n - 1; nivel >= 0; nivel -= 1) {
    let unionMaskNivel = 0;
    const optsNivel = ordenadas[nivel].opcionesInfo;
    for (let j = 0; j < optsNivel.length; j += 1) {
      unionMaskNivel |= optsNivel[j].diasMask;
    }
    for (let d = 0; d < numDias; d += 1) {
      restantesPorDia[nivel][d] =
        restantesPorDia[nivel + 1][d] + ((unionMaskNivel & (1 << d)) !== 0 ? 1 : 0);
    }
  }

  const seleccionIndices = new Array(n);
  const clasesPorDiaAcum = new Int32Array(numDias);
  const topResultados = [];
  let combinacionesEvaluadas = 0;
  let combinacionesValidas = 0;
  let nodosExplorados = 0;
  let podasPorCota = 0;
  let limiteAlcanzado = false;
  const maxNodos = maxCombinacionesEvaluadas * 15;

  const backtrack = (nivel, solapamientoAcumulado, diasMaskAcum, fueraRangoAcum) => {
    if (limiteAlcanzado) {
      return;
    }

    if (nivel === n) {
      combinacionesEvaluadas += 1;
      combinacionesValidas += 1;

      const diasOcupados = contarBits(diasMaskAcum);
      const diasLibres = numDias - diasOcupados;

      let totalHuecosMin = 0;
      for (let d = 0; d < numDias; d += 1) {
        if ((diasMaskAcum & (1 << d)) === 0) {
          continue;
        }
        const bloquesDia = [];
        for (let i = 0; i < n; i += 1) {
          const bDia = ordenadas[i].opcionesInfo[seleccionIndices[i]].porDia[d];
          for (let k = 0; k < bDia.length; k += 1) {
            bloquesDia.push(bDia[k]);
          }
        }
        if (bloquesDia.length >= 2) {
          totalHuecosMin += calcularHuecosDia(bloquesDia);
        }
      }

      const indiceConcentracion = calcularIndiceConcentracion(clasesPorDiaAcum);

      const metricasParciales = {
        diasLibres,
        indiceConcentracion,
        totalHuecosMin,
        minutosFueraRango: fueraRangoAcum,
        totalMinutosSolapamiento: solapamientoAcumulado,
      };
      const puntajeRapido = redondear2(
        100 +
          diasLibres * pesos.diasLibres +
          indiceConcentracion * pesos.concentracionDiaria -
          (totalHuecosMin / 60) * pesos.huecos -
          (fueraRangoAcum / 60) * pesos.rangoHorario -
          solapamientoAcumulado * pesos.solapamiento
      );

      // Reconstruye la selección en el orden original solo para comparar firma si empata
      const registros = new Array(n);
      for (let i = 0; i < n; i += 1) {
        const materiaObj = ordenadas[i];
        registros[materiaObj.indiceOriginal] =
          materiaObj.opcionesInfo[seleccionIndices[i]].registro;
      }
      const firma = construirFirmaRegistros(registros);

      insertarEnTopOrdenado(
        topResultados,
        {
          id: firma,
          registros,
          puntaje: puntajeRapido,
          metricas: metricasParciales,
          _firma: firma,
        },
        limiteResultados
      );

      if (combinacionesEvaluadas >= maxCombinacionesEvaluadas) {
        limiteAlcanzado = true;
      }
      return;
    }

    const opcionesNivel = ordenadas[nivel].opcionesInfo;
    for (let idxOpt = 0; idxOpt < opcionesNivel.length; idxOpt += 1) {
      nodosExplorados += 1;
      if (nodosExplorados > maxNodos) {
        limiteAlcanzado = true;
        return;
      }

      const infoOpt = opcionesNivel[idxOpt];
      let deltaSolapamiento = 0;
      let excede = false;

      for (let prevNivel = 0; prevNivel < nivel; prevNivel += 1) {
        deltaSolapamiento += obtenerSolapamientoCached(
          prevNivel,
          seleccionIndices[prevNivel],
          nivel,
          idxOpt
        );
        if (solapamientoAcumulado + deltaSolapamiento > toleranciaEfectivaMin) {
          excede = true;
          break;
        }
      }

      if (excede) {
        continue;
      }

      const nuevoSolap = solapamientoAcumulado + deltaSolapamiento;
      const nuevoDiasMask = diasMaskAcum | infoOpt.diasMask;
      const nuevoFueraRango = fueraRangoAcum + infoOpt.fueraRangoMin;

      // Poda exacta Branch-and-Bound combinando días libres y concentración diaria máxima posible
      if (puedePodarPorCota && topResultados.length >= limiteResultados) {
        const remNivel = restantesPorDia[nivel + 1];
        let diasActivosMin = 0;
        let maxC = 0;
        let sumMaxC = 0;
        let minPenalizacionPocas = 0;
        for (let d = 0; d < numDias; d += 1) {
          const cActual =
            clasesPorDiaAcum[d] + ((infoOpt.diasMask & (1 << d)) !== 0 ? 1 : 0);
          const cMax = cActual + remNivel[d];
          if (cMax > maxC) {
            maxC = cMax;
          }
          sumMaxC += cMax;
          if (cActual > 0) {
            diasActivosMin += 1;
            if (cMax === 1) {
              minPenalizacionPocas += 1.5;
            } else if (cMax === 2) {
              minPenalizacionPocas += 0.75;
            }
          }
        }
        const maxDiasLibres = numDias - diasActivosMin;
        let maxIndiceConcentracion = 0;
        if (sumMaxC > 0) {
          if (diasActivosMin === 0) {
            maxIndiceConcentracion = Math.max(0, maxC + 2);
          } else {
            const maxPromedio = Math.min(maxC, sumMaxC / diasActivosMin);
            maxIndiceConcentracion =
              maxPromedio + (3 - diasActivosMin) - minPenalizacionPocas;
          }
        }
        const cotaSuperior =
          100 +
          maxDiasLibres * pesos.diasLibres +
          maxIndiceConcentracion * pesos.concentracionDiaria -
          (nuevoFueraRango / 60) * pesos.rangoHorario -
          nuevoSolap * pesos.solapamiento;
        const margenRedondeo = 0.01 + 0.005 * pesos.concentracionDiaria;
        const peorTop = topResultados[topResultados.length - 1].puntaje;
        if (cotaSuperior + margenRedondeo < peorTop) {
          podasPorCota += 1;
          continue;
        }
      }

      for (let d = 0; d < numDias; d += 1) {
        if ((infoOpt.diasMask & (1 << d)) !== 0) {
          clasesPorDiaAcum[d] += 1;
        }
      }
      seleccionIndices[nivel] = idxOpt;
      backtrack(nivel + 1, nuevoSolap, nuevoDiasMask, nuevoFueraRango);
      for (let d = 0; d < numDias; d += 1) {
        if ((infoOpt.diasMask & (1 << d)) !== 0) {
          clasesPorDiaAcum[d] -= 1;
        }
      }

      if (limiteAlcanzado) {
        return;
      }
    }
  };

  backtrack(0, 0, 0, 0);

  // Calcula métricas detalladas, desglose y advertencias únicamente para los ganadores finales
  const recomendaciones = topResultados.map(({ _firma, registros }) => {
    const analisis = detectarSolapamientosHorario(registros);
    const metricas = calcularMetricasHorario(registros, {
      horaIdealInicioMin,
      horaIdealFinMin,
      diasConsiderados,
      resumenSolapamientos: analisis,
    });
    const evaluacion = calcularPuntaje(metricas, pesos);
    return {
      id: _firma,
      registros,
      puntaje: evaluacion.puntaje,
      desglosePuntaje: evaluacion.desglose,
      metricas,
      solapamientos: analisis.solapamientos,
      advertencias: analisis.advertencias,
      tieneSolapamiento: analisis.tieneSolapamiento,
    };
  });

  const diagnostico =
    recomendaciones.length === 0
      ? diagnosticarConflictos(materias, opciones)
      : null;

  return {
    recomendaciones,
    estadisticas: {
      combinacionesEvaluadas,
      combinacionesValidas,
      nodosExplorados,
      podasPorCota,
      limiteAlcanzado,
      tiempoMs: Date.now() - inicioMs,
      toleranciaEfectivaMin,
    },
    diagnostico,
  };
}
