/**
 * Controlador principal de estado, carga de datos, filtros multiparámetro,
 * agrupación por asignatura y puente con el motor de recomendación.
 *
 * Mantiene la lógica desacoplada del DOM para que la capa de presentación
 * (index.html, styles.css y render.js) pueda conectarse en la etapa de diseño UI.
 */

import {
  DIAS_SEMANA,
  PESOS_POR_DEFECTO,
  PRESETS_PREFERENCIAS,
  calcularMetricasHorario,
  calcularPuntaje,
  detectarSolapamientosHorario,
  esBloqueValido,
  formatearEtiquetaSemestre,
  generarRecomendaciones,
  horaAMinutos,
  minutosAHora,
  obtenerSemestreDeGrupo,
} from "./scheduler.js";
import {
  exportarHorarioPNG,
  renderizarCatalogoFiltros,
  renderizarCatalogoMaterias,
  renderizarCatalogoPorGrupo,
  renderizarComparadorManual,
  renderizarDiagnostico,
  renderizarGrillaSemanal,
  renderizarInspectorBloque,
  renderizarMateriasSeleccionadas,
  renderizarRecomendaciones,
  renderizarSelectDatasets,
  renderizarSelectSemestres,
} from "./render.js";

export { formatearEtiquetaSemestre, obtenerSemestreDeGrupo };

export const FILTROS_POR_DEFECTO = Object.freeze({
  texto: "",
  semestresGrupo: [], // vacío = todos los semestres; array de enteros 1..10
  diasActivos: null, // null = sin restricción de días; array = solo bloques dentro de estos días
  horaMinInicio: null, // minutos o "HH:MM"
  horaMaxFin: null, // minutos o "HH:MM"
  tiposClase: [], // vacío = todas las modalidades
  soloConCupo: false,
  cupoMinimo: null,
  profesoresExcluidos: [],
  gruposExcluidos: [],
  materiasExcluidas: [],
  incluirSinHorario: true,
});

export const PREFERENCIAS_POR_DEFECTO = Object.freeze({
  preset: "balanceado",
  horaIdealInicioMin: 420, // 07:00
  horaIdealFinMin: 1320, // 22:00
  permitirSolapamiento: false,
  toleranciaSolapamientoMin: 0,
  maxCombinacionesEvaluadas: 25000,
  limiteResultados: 20,
  diasConsiderados: [...DIAS_SEMANA],
  pesos: { ...PESOS_POR_DEFECTO },
});

/**
 * Normaliza una cadena eliminando acentos/diacríticos, pasando a minúsculas y colapsando espacios.
 */
export function normalizarTexto(texto) {
  if (texto === null || texto === undefined) {
    return "";
  }
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Consolida registros divididos o con múltiples docentes que comparten la misma
 * combinación `(semestre, carrera, clv_materia, grupo)` en una sola opción real.
 */
export function consolidarRegistrosPorGrupoMateria(horarios = []) {
  const lista = Array.isArray(horarios) ? horarios : [];
  const ordenDias = new Map(DIAS_SEMANA.map((d, i) => [d, i]));
  const grupos = new Map();

  for (const reg of lista) {
    if (!reg || typeof reg !== "object") {
      continue;
    }
    const sem = String(reg.semestre ?? "").trim();
    const carr = String(reg.carrera ?? "").trim();
    const clv = String(reg.clv_materia ?? "").trim();
    const grp = String(reg.grupo ?? "").trim();

    if (!clv || !grp) {
      const claveFallback = `__raw_${grupos.size}`;
      grupos.set(claveFallback, { base: reg, lista: [reg] });
      continue;
    }

    const llave = `${sem}|${carr}|${clv}|${grp}`;
    if (!grupos.has(llave)) {
      grupos.set(llave, { base: reg, lista: [reg] });
    } else {
      grupos.get(llave).lista.push(reg);
    }
  }

  const consolidados = [];
  for (const { base, lista: regs } of grupos.values()) {
    if (regs.length === 1) {
      consolidados.push(base);
      continue;
    }

    const profesores = [];
    const profSet = new Set();
    const salones = [];
    const salonSet = new Set();
    const tipos = [];
    const tipoSet = new Set();
    const bloquesUnicos = [];
    const bloqueKeys = new Set();
    let cupoMax = null;
    let mejorId = base.id || "";

    for (const r of regs) {
      if (r.id && (!mejorId || r.id.length < mejorId.length)) {
        mejorId = r.id;
      }
      const prof = String(r.profesor || "").trim();
      if (prof && !profSet.has(prof)) {
        profSet.add(prof);
        profesores.push(prof);
      }
      const salon = String(r.salon || "").trim();
      if (salon && !salonSet.has(salon)) {
        salonSet.add(salon);
        salones.push(salon);
      }
      const tipo = String(r.tipo_clase || "").trim();
      if (tipo && !tipoSet.has(tipo)) {
        tipoSet.add(tipo);
        tipos.push(tipo);
      }
      if (Number.isFinite(r.cupo)) {
        cupoMax = cupoMax === null ? r.cupo : Math.max(cupoMax, r.cupo);
      }
      if (Array.isArray(r.bloques)) {
        for (const b of r.bloques) {
          const bKey = `${b.dia}|${b.inicio_min}|${b.fin_min}|${b.hora_texto}`;
          if (!bloqueKeys.has(bKey)) {
            bloqueKeys.add(bKey);
            bloquesUnicos.push(b);
          }
        }
      }
    }

    bloquesUnicos.sort((a, b) => {
      const da = ordenDias.get(a.dia) ?? 99;
      const db = ordenDias.get(b.dia) ?? 99;
      return da - db || (a.inicio_min ?? 9999) - (b.inicio_min ?? 9999);
    });

    consolidados.push({
      ...base,
      id: mejorId || base.id,
      profesor: profesores.join(" / "),
      salon: salones.join(" / "),
      tipo_clase: tipos.join(" / ") || base.tipo_clase || "",
      cupo: cupoMax,
      bloques: bloquesUnicos,
    });
  }

  return consolidados;
}

/**
 * Extrae `{ metadata, horarios }` soportando tanto el objeto estructurado del ETL como arreglos planos.
 */
export function extraerRegistrosDeDataset(payload) {
  if (Array.isArray(payload)) {
    return { metadata: null, horarios: consolidarRegistrosPorGrupoMateria(payload) };
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.horarios)) {
    return {
      metadata: payload.metadata ?? null,
      horarios: consolidarRegistrosPorGrupoMateria(payload.horarios),
    };
  }
  throw new Error(
    "Formato de dataset inválido: se esperaba un arreglo o un objeto con la propiedad 'horarios'."
  );
}

/**
 * Descarga y valida un archivo JSON estático desde la ruta o URL indicada.
 */
export async function cargarDataset(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No hay implementación de fetch disponible en este entorno.");
  }

  const respuesta = await fetchImpl(url);
  if (!respuesta || !respuesta.ok) {
    const status = respuesta ? respuesta.status : "desconocido";
    throw new Error(`Error al cargar el archivo de horarios (${url}): HTTP ${status}.`);
  }

  const json = await respuesta.json();
  return extraerRegistrosDeDataset(json);
}

/**
 * Crea un estado inicial limpio para la aplicación.
 */
export function crearEstadoInicial() {
  return {
    metadata: null,
    horarios: [],
    filtros: {
      ...FILTROS_POR_DEFECTO,
      semestresGrupo: [],
      tiposClase: [],
      profesoresExcluidos: [],
      gruposExcluidos: [],
      materiasExcluidas: [],
    },
    materiasSeleccionadas: [],
    preferencias: {
      ...PREFERENCIAS_POR_DEFECTO,
      diasConsiderados: [...DIAS_SEMANA],
      pesos: { ...PESOS_POR_DEFECTO },
    },
    resultadoRecomendaciones: null,
    recomendacionActivaId: null,
    seleccionManual: [],
  };
}

function coincideTextoLibre(registro, tokensBusqueda) {
  if (tokensBusqueda.length === 0) {
    return true;
  }

  const campos = [
    normalizarTexto(registro.materia),
    normalizarTexto(registro.clv_materia),
    normalizarTexto(registro.profesor),
    normalizarTexto(registro.grupo),
  ];

  return tokensBusqueda.every((token) =>
    campos.some((campo) => campo.includes(token))
  );
}

/**
 * Aplica todos los filtros multiparámetro sobre la lista de horarios (RF-BUS-01, RF-BUS-02, RF-BUS-03).
 */
export function filtrarHorarios(horarios = [], filtros = {}) {
  const lista = Array.isArray(horarios) ? horarios : [];
  const textoNormalizado = normalizarTexto(filtros.texto);
  const tokensBusqueda = textoNormalizado ? textoNormalizado.split(" ") : [];

  const semestresLista = Array.isArray(filtros.semestresGrupo)
    ? filtros.semestresGrupo
    : filtros.semestresGrupo !== null &&
      filtros.semestresGrupo !== undefined &&
      filtros.semestresGrupo !== ""
    ? [filtros.semestresGrupo]
    : [];
  const semestresActivos =
    semestresLista.length > 0
      ? new Set(
          semestresLista
            .map((s) => Number(s))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)
        )
      : null;

  const diasActivos = Array.isArray(filtros.diasActivos)
    ? new Set(filtros.diasActivos.map((d) => String(d).trim().toUpperCase()))
    : null;

  const horaMinInicio =
    filtros.horaMinInicio !== null && filtros.horaMinInicio !== undefined && filtros.horaMinInicio !== ""
      ? horaAMinutos(filtros.horaMinInicio)
      : null;
  const horaMaxFin =
    filtros.horaMaxFin !== null && filtros.horaMaxFin !== undefined && filtros.horaMaxFin !== ""
      ? horaAMinutos(filtros.horaMaxFin)
      : null;

  const tiposClase =
    Array.isArray(filtros.tiposClase) && filtros.tiposClase.length > 0
      ? new Set(filtros.tiposClase.map((t) => normalizarTexto(t)))
      : null;

  const soloConCupo = Boolean(filtros.soloConCupo);
  const cupoMinimo =
    filtros.cupoMinimo !== null &&
    filtros.cupoMinimo !== undefined &&
    filtros.cupoMinimo !== "" &&
    Number.isFinite(Number(filtros.cupoMinimo))
      ? Number(filtros.cupoMinimo)
      : null;

  const profesoresExcluidos = new Set(
    (Array.isArray(filtros.profesoresExcluidos)
      ? filtros.profesoresExcluidos
      : []
    )
      .map(normalizarTexto)
      .filter(Boolean)
  );

  const gruposExcluidos = new Set(
    (Array.isArray(filtros.gruposExcluidos) ? filtros.gruposExcluidos : [])
      .map((g) => String(g).trim().toUpperCase())
      .filter(Boolean)
  );

  const materiasExcluidas = new Set(
    (Array.isArray(filtros.materiasExcluidas) ? filtros.materiasExcluidas : [])
      .map((m) => String(m).trim().toUpperCase())
      .filter(Boolean)
  );

  const incluirSinHorario = filtros.incluirSinHorario !== false;

  return lista.filter((registro) => {
    if (!coincideTextoLibre(registro, tokensBusqueda)) {
      return false;
    }

    if (semestresActivos && semestresActivos.size > 0) {
      const semGrupo = obtenerSemestreDeGrupo(registro.grupo);
      if (semGrupo === null || !semestresActivos.has(semGrupo)) {
        return false;
      }
    }

    const claveMat = String(registro.clv_materia || "").trim().toUpperCase();
    if (materiasExcluidas.has(claveMat)) {
      return false;
    }

    const profNorm = normalizarTexto(registro.profesor);
    if (profNorm && profesoresExcluidos.has(profNorm)) {
      return false;
    }

    const grupoUpper = String(registro.grupo || "").trim().toUpperCase();
    const idUpper = String(registro.id || "").trim().toUpperCase();
    const parMateriaGrupo = `${claveMat}:${grupoUpper}`;
    if (
      gruposExcluidos.has(grupoUpper) ||
      (idUpper && gruposExcluidos.has(idUpper)) ||
      gruposExcluidos.has(parMateriaGrupo)
    ) {
      return false;
    }

    if (tiposClase) {
      const tipoNorm = normalizarTexto(registro.tipo_clase);
      if (!tiposClase.has(tipoNorm)) {
        return false;
      }
    }

    if (soloConCupo) {
      if (!Number.isFinite(registro.cupo) || registro.cupo <= 0) {
        return false;
      }
    }

    if (cupoMinimo !== null) {
      if (!Number.isFinite(registro.cupo) || registro.cupo < cupoMinimo) {
        return false;
      }
    }

    const bloques = Array.isArray(registro.bloques) ? registro.bloques : [];
    const bloquesValidos = bloques.filter(esBloqueValido);

    if (bloquesValidos.length === 0) {
      return incluirSinHorario;
    }

    for (const bloque of bloquesValidos) {
      if (diasActivos && !diasActivos.has(bloque.dia)) {
        return false;
      }
      if (horaMinInicio !== null && bloque.inicio_min < horaMinInicio) {
        return false;
      }
      if (horaMaxFin !== null && bloque.fin_min > horaMaxFin) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Agrupa registros filtrados por asignatura (clave y nombre) para su selección (RF-BUS-04).
 */
export function agruparPorMateria(horarios = []) {
  const lista = Array.isArray(horarios) ? horarios : [];
  const mapa = new Map();

  for (const registro of lista) {
    const clave =
      String(registro.clv_materia || "").trim() ||
      normalizarTexto(registro.materia) ||
      "SIN_CLAVE";

    if (!mapa.has(clave)) {
      mapa.set(clave, {
        clave,
        materia: registro.materia || clave,
        grupos: [],
        profesoresSet: new Set(),
        tiposClaseSet: new Set(),
      });
    }

    const grupoMateria = mapa.get(clave);
    grupoMateria.grupos.push(registro);
    if (registro.profesor) {
      grupoMateria.profesoresSet.add(registro.profesor);
    }
    if (registro.tipo_clase) {
      grupoMateria.tiposClaseSet.add(registro.tipo_clase);
    }
  }

  return Array.from(mapa.values())
    .map((entry) => ({
      clave: entry.clave,
      materia: entry.materia,
      grupos: [...entry.grupos].sort((a, b) =>
        String(a.grupo || "").localeCompare(String(b.grupo || ""), "es")
      ),
      totalGrupos: entry.grupos.length,
      profesores: Array.from(entry.profesoresSet).sort((a, b) =>
        a.localeCompare(b, "es")
      ),
      tiposClase: Array.from(entry.tiposClaseSet).sort((a, b) =>
        a.localeCompare(b, "es")
      ),
    }))
    .sort(
      (a, b) =>
        a.materia.localeCompare(b.materia, "es") ||
        a.clave.localeCompare(b.clave, "es")
    );
}

/**
 * Agrupa registros filtrados por grupo académico (`grupo`), conservando las claves
 * únicas de sus asignaturas para permitir seleccionar todo el grupo en un clic.
 */
export function agruparPorGrupo(horarios = []) {
  const lista = Array.isArray(horarios) ? horarios : [];
  const mapa = new Map();

  for (const registro of lista) {
    const grupo = String(registro.grupo || "").trim() || "SIN_GRUPO";
    if (!mapa.has(grupo)) {
      mapa.set(grupo, {
        grupo,
        registros: [],
        clavesSet: new Set(),
        tiposClaseSet: new Set(),
      });
    }

    const entry = mapa.get(grupo);
    entry.registros.push(registro);

    const clave = String(registro.clv_materia || "").trim();
    if (clave) {
      entry.clavesSet.add(clave);
    }
    if (registro.tipo_clase) {
      entry.tiposClaseSet.add(registro.tipo_clase);
    }
  }

  return Array.from(mapa.values())
    .map((entry) => {
      const registrosOrdenados = [...entry.registros].sort(
        (a, b) =>
          String(a.materia || "").localeCompare(String(b.materia || ""), "es") ||
          String(a.clv_materia || "").localeCompare(String(b.clv_materia || ""), "es")
      );
      const clavesMaterias = Array.from(entry.clavesSet);
      return {
        grupo: entry.grupo,
        registros: registrosOrdenados,
        clavesMaterias,
        totalMaterias: clavesMaterias.length,
        totalRegistros: registrosOrdenados.length,
        tiposClase: Array.from(entry.tiposClaseSet).sort((a, b) =>
          a.localeCompare(b, "es")
        ),
      };
    })
    .sort((a, b) =>
      a.grupo.localeCompare(b.grupo, "es", { numeric: true })
    );
}

/**
 * Extrae catálogos únicos del dataset para poblar los controles de filtros.
 */
export function obtenerCatalogosDeFiltros(horarios = []) {
  const lista = Array.isArray(horarios) ? horarios : [];
  const tiposClase = new Set();
  const profesores = new Set();
  const grupos = new Set();
  const materiasMap = new Map();
  const semestresMap = new Map();
  let minHoraMin = null;
  let maxHoraMin = null;

  for (const registro of lista) {
    if (registro.tipo_clase) {
      tiposClase.add(registro.tipo_clase);
    }
    if (registro.profesor) {
      profesores.add(registro.profesor);
    }
    if (registro.grupo) {
      const grpStr = String(registro.grupo);
      grupos.add(grpStr);
      const semNum = obtenerSemestreDeGrupo(grpStr);
      if (semNum !== null) {
        if (!semestresMap.has(semNum)) {
          semestresMap.set(semNum, {
            grupos: new Set(),
            materias: new Set(),
          });
        }
        const entrySem = semestresMap.get(semNum);
        entrySem.grupos.add(grpStr);
        if (registro.clv_materia) {
          entrySem.materias.add(registro.clv_materia);
        }
      }
    }
    if (registro.clv_materia) {
      materiasMap.set(
        registro.clv_materia,
        registro.materia || registro.clv_materia
      );
    }

    if (Array.isArray(registro.bloques)) {
      for (const bloque of registro.bloques) {
        if (esBloqueValido(bloque)) {
          if (minHoraMin === null || bloque.inicio_min < minHoraMin) {
            minHoraMin = bloque.inicio_min;
          }
          if (maxHoraMin === null || bloque.fin_min > maxHoraMin) {
            maxHoraMin = bloque.fin_min;
          }
        }
      }
    }
  }

  return {
    tiposClase: Array.from(tiposClase).sort((a, b) => a.localeCompare(b, "es")),
    profesores: Array.from(profesores).sort((a, b) => a.localeCompare(b, "es")),
    grupos: Array.from(grupos).sort((a, b) => a.localeCompare(b, "es")),
    materias: Array.from(materiasMap.entries())
      .map(([clave, materia]) => ({ clave, materia }))
      .sort((a, b) => a.materia.localeCompare(b.materia, "es")),
    semestresGrupo: Array.from(semestresMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([numero, datos]) => ({
        numero,
        etiqueta: formatearEtiquetaSemestre(numero),
        totalGrupos: datos.grupos.size,
        totalMaterias: datos.materias.size,
      })),
    minHoraMin,
    maxHoraMin,
  };
}

/**
 * Crea un controlador reactivo para gestionar estado, filtros, exclusiones y recomendaciones.
 */
export function crearControladorHorarios(configInicial = {}) {
  const estado = crearEstadoInicial();
  if (configInicial.horarios || configInicial.metadata) {
    estado.metadata = configInicial.metadata ?? null;
    estado.horarios = Array.isArray(configInicial.horarios)
      ? consolidarRegistrosPorGrupoMateria(configInicial.horarios)
      : [];
  }

  const suscriptores = new Set();

  const notificar = () => {
    for (const fn of suscriptores) {
      fn(obtenerEstado());
    }
  };

  function obtenerEstado() {
    return {
      ...estado,
      filtros: {
        ...estado.filtros,
        semestresGrupo: [...(estado.filtros.semestresGrupo || [])],
        diasActivos: estado.filtros.diasActivos
          ? [...estado.filtros.diasActivos]
          : null,
        tiposClase: [...estado.filtros.tiposClase],
        profesoresExcluidos: [...estado.filtros.profesoresExcluidos],
        gruposExcluidos: [...estado.filtros.gruposExcluidos],
        materiasExcluidas: [...estado.filtros.materiasExcluidas],
      },
      materiasSeleccionadas: [...estado.materiasSeleccionadas],
      preferencias: {
        ...estado.preferencias,
        diasConsiderados: [...estado.preferencias.diasConsiderados],
        pesos: { ...estado.preferencias.pesos },
      },
      seleccionManual: [...estado.seleccionManual],
    };
  }

  function suscribir(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("El suscriptor debe ser una función.");
    }
    suscriptores.add(listener);
    return () => suscriptores.delete(listener);
  }

  async function cargarDatos(url, fetchImpl = globalThis.fetch) {
    const { metadata, horarios } = await cargarDataset(url, fetchImpl);
    estado.metadata = metadata;
    estado.horarios = horarios;
    estado.materiasSeleccionadas = [];
    estado.resultadoRecomendaciones = null;
    estado.recomendacionActivaId = null;
    estado.seleccionManual = [];
    notificar();
    return obtenerEstado();
  }

  function establecerDatos(payload) {
    const { metadata, horarios } = extraerRegistrosDeDataset(payload);
    estado.metadata = metadata;
    estado.horarios = horarios;
    estado.materiasSeleccionadas = [];
    estado.resultadoRecomendaciones = null;
    estado.recomendacionActivaId = null;
    estado.seleccionManual = [];
    notificar();
    return obtenerEstado();
  }

  function actualizarFiltros(parcial = {}) {
    estado.filtros = {
      ...estado.filtros,
      ...parcial,
    };
    notificar();
  }

  function limpiarFiltros() {
    estado.filtros = crearEstadoInicial().filtros;
    notificar();
  }

  function alternarMateriaSeleccionada(claveMateria) {
    const clave = String(claveMateria || "").trim();
    if (!clave) {
      return;
    }
    if (estado.materiasSeleccionadas.includes(clave)) {
      estado.materiasSeleccionadas = estado.materiasSeleccionadas.filter(
        (c) => c !== clave
      );
    } else {
      estado.materiasSeleccionadas = [...estado.materiasSeleccionadas, clave];
    }
    notificar();
  }

  function seleccionarMaterias(claves = []) {
    const unicas = [];
    const vistas = new Set();
    for (const c of claves) {
      const clave = String(c || "").trim();
      if (clave && !vistas.has(clave)) {
        vistas.add(clave);
        unicas.push(clave);
      }
    }
    estado.materiasSeleccionadas = unicas;
    notificar();
  }

  function limpiarMateriasSeleccionadas() {
    estado.materiasSeleccionadas = [];
    estado.resultadoRecomendaciones = null;
    estado.recomendacionActivaId = null;
    notificar();
  }

  function excluirProfesor(nombreProfesor) {
    const nombre = String(nombreProfesor || "").trim();
    const norm = normalizarTexto(nombre);
    if (
      norm &&
      !estado.filtros.profesoresExcluidos.some((p) => normalizarTexto(p) === norm)
    ) {
      estado.filtros.profesoresExcluidos = [
        ...estado.filtros.profesoresExcluidos,
        nombre,
      ];
      notificar();
    }
  }

  function quitarProfesorExcluido(nombreProfesor) {
    const norm = normalizarTexto(nombreProfesor);
    estado.filtros.profesoresExcluidos =
      estado.filtros.profesoresExcluidos.filter(
        (p) => normalizarTexto(p) !== norm
      );
    notificar();
  }

  function excluirGrupo(claveGrupo) {
    const valor = String(claveGrupo || "").trim();
    if (
      valor &&
      !estado.filtros.gruposExcluidos.some(
        (g) => g.toUpperCase() === valor.toUpperCase()
      )
    ) {
      estado.filtros.gruposExcluidos = [
        ...estado.filtros.gruposExcluidos,
        valor,
      ];
      notificar();
    }
  }

  function quitarGrupoExcluido(claveGrupo) {
    const upper = String(claveGrupo || "").trim().toUpperCase();
    estado.filtros.gruposExcluidos = estado.filtros.gruposExcluidos.filter(
      (g) => g.toUpperCase() !== upper
    );
    notificar();
  }

  function actualizarPreferencias(parcial = {}) {
    const nuevosPesos = parcial.pesos
      ? { ...estado.preferencias.pesos, ...parcial.pesos }
      : { ...estado.preferencias.pesos };

    estado.preferencias = {
      ...estado.preferencias,
      ...parcial,
      pesos: nuevosPesos,
    };
    notificar();
  }

  function aplicarPresetPreferencias(presetId) {
    const preset = PRESETS_PREFERENCIAS[presetId];
    if (!preset) {
      throw new Error(`Preset de preferencias desconocido: ${presetId}`);
    }
    estado.preferencias = {
      ...estado.preferencias,
      preset: preset.id,
      horaIdealInicioMin: preset.horaIdealInicioMin,
      horaIdealFinMin: preset.horaIdealFinMin,
      pesos: { ...preset.pesos },
    };
    notificar();
  }

  function obtenerHorariosFiltrados() {
    return filtrarHorarios(estado.horarios, estado.filtros);
  }

  function obtenerMateriasFiltradas() {
    return agruparPorMateria(obtenerHorariosFiltrados());
  }

  function obtenerGruposFiltrados() {
    return agruparPorGrupo(obtenerHorariosFiltrados());
  }

  function obtenerCatalogos() {
    return obtenerCatalogosDeFiltros(estado.horarios);
  }

  /**
   * Ejecuta el motor de recomendación usando las materias seleccionadas y los filtros activos.
   */
  function generarHorariosRecomendados() {
    // Al armar combinaciones de materias ya elegidas se conservan los filtros
    // de horario/modalidad/exclusiones sin perder materias por el buscador o semestre visible
    const filtrados = filtrarHorarios(estado.horarios, {
      ...estado.filtros,
      texto: "",
      semestresGrupo: [],
    });
    const agrupados = agruparPorMateria(filtrados);
    const mapaAgrupado = new Map(agrupados.map((m) => [m.clave, m]));
    const mapaNombresGlobal = new Map();
    for (const reg of estado.horarios) {
      if (reg.clv_materia && !mapaNombresGlobal.has(reg.clv_materia)) {
        mapaNombresGlobal.set(reg.clv_materia, reg.materia || reg.clv_materia);
      }
    }

    const entradaMotor = estado.materiasSeleccionadas.map((clave) => {
      const encontrado = mapaAgrupado.get(clave);
      return {
        clave,
        materia:
          encontrado?.materia || mapaNombresGlobal.get(clave) || clave,
        opciones: encontrado ? encontrado.grupos : [],
      };
    });

    const resultado = generarRecomendaciones(entradaMotor, estado.preferencias);
    estado.resultadoRecomendaciones = resultado;
    estado.recomendacionActivaId =
      resultado.recomendaciones.length > 0
        ? resultado.recomendaciones[0].id
        : null;
    notificar();
    return resultado;
  }

  function seleccionarRecomendacion(id) {
    estado.recomendacionActivaId = id ?? null;
    notificar();
  }

  /**
   * Evalúa una selección manual de registros para inspección/comparación (RF-VIS-03).
   */
  function construirHorarioManual(registrosManuales = null) {
    const registros = Array.isArray(registrosManuales)
      ? registrosManuales
      : estado.seleccionManual;

    if (registrosManuales !== null) {
      estado.seleccionManual = [...registros];
    }

    const metricas = calcularMetricasHorario(registros, estado.preferencias);
    const evaluacion = calcularPuntaje(metricas, estado.preferencias.pesos);
    const analisis = detectarSolapamientosHorario(registros);

    const resumen = {
      registros,
      puntaje: evaluacion.puntaje,
      desglosePuntaje: evaluacion.desglose,
      metricas,
      solapamientos: analisis.solapamientos,
      advertencias: analisis.advertencias,
      tieneSolapamiento: analisis.tieneSolapamiento,
    };

    if (registrosManuales !== null) {
      notificar();
    }
    return resumen;
  }

  return {
    obtenerEstado,
    suscribir,
    cargarDatos,
    establecerDatos,
    actualizarFiltros,
    limpiarFiltros,
    alternarMateriaSeleccionada,
    seleccionarMaterias,
    limpiarMateriasSeleccionadas,
    excluirProfesor,
    quitarProfesorExcluido,
    excluirGrupo,
    quitarGrupoExcluido,
    actualizarPreferencias,
    aplicarPresetPreferencias,
    obtenerHorariosFiltrados,
    obtenerMateriasFiltradas,
    obtenerGruposFiltrados,
    obtenerCatalogos,
    generarHorariosRecomendados,
    seleccionarRecomendacion,
    construirHorarioManual,
  };
}

/**
 * Carga el catálogo `data/index.json` intentando rutas relativas estándar.
 */
export async function cargarIndiceDatasets(
  rutas = ["./data/index.json", "../data/index.json"],
  fetchImpl = globalThis.fetch
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("No hay implementación de fetch disponible.");
  }

  for (const ruta of rutas) {
    try {
      const resp = await fetchImpl(ruta);
      if (resp && resp.ok) {
        const json = await resp.json();
        const baseUrl = ruta.replace(/\/index\.json$/, "");
        return {
          baseUrl,
          semestreActivo: json.semestre_activo || null,
          datasets: Array.isArray(json.datasets) ? json.datasets : [],
        };
      }
    } catch {
      // Intenta la siguiente ruta disponible
    }
  }

  return {
    baseUrl: "./data",
    semestreActivo: {
      semestre: "35",
      etiqueta_semestre: "2027-1",
    },
    datasets: [
      {
        archivo: "sem_35_carr_12.json",
        semestre: "35",
        etiqueta_semestre: "2027-1",
        carrera: "12",
        nombre_carrera: "INGENIERIA EN COMPUTACION",
      },
    ],
  };
}

function contarFiltrosActivos(filtros = {}) {
  let total = 0;
  if (Array.isArray(filtros.diasActivos) && filtros.diasActivos.length < DIAS_SEMANA.length) {
    total += 1;
  }
  if (filtros.horaMinInicio !== null && filtros.horaMinInicio !== undefined && filtros.horaMinInicio !== "") {
    total += 1;
  }
  if (filtros.horaMaxFin !== null && filtros.horaMaxFin !== undefined && filtros.horaMaxFin !== "") {
    total += 1;
  }
  if (Array.isArray(filtros.tiposClase) && filtros.tiposClase.length > 0) {
    total += 1;
  }
  if (filtros.soloConCupo || (filtros.cupoMinimo !== null && filtros.cupoMinimo !== undefined)) {
    total += 1;
  }
  total += (filtros.profesoresExcluidos || []).length;
  total += (filtros.gruposExcluidos || []).length;
  return total;
}

function poblarSelectHoras(selectEl, incluirVacio = false, etiquetaVacio = "Todas", horaDefecto = null) {
  if (!selectEl) {
    return;
  }
  const opciones = [];
  if (incluirVacio) {
    opciones.push(`<option value="">${etiquetaVacio}</option>`);
  }
  for (let h = 7; h <= 22; h += 1) {
    const min = h * 60;
    const texto = minutosAHora(min);
    const selected = horaDefecto === min ? "selected" : "";
    opciones.push(`<option value="${min}" ${selected}>${texto}</option>`);
  }
  selectEl.innerHTML = opciones.join("");
}

/**
 * Conecta el controlador lógico con los elementos del DOM e inicia la aplicación web.
 */
export async function iniciarAplicacionWeb(doc = globalThis.document) {
  if (!doc) {
    return null;
  }
  const root = doc.getElementById("app-horarios");
  if (!root) {
    return null;
  }

  const ctrl = crearControladorHorarios();
  const materiasExpandidas = new Set();
  const gruposExpandidos = new Set();
  let modoVista = "recomendado";
  let modoCatalogo = "grupo";
  let tabPanelActivo = "materias";
  let limiteVisibleRecs = 6;
  let bloqueInspectorId = "";
  let registroInspectorId = "";
  let baseDataUrl = "./data";
  let semestreActivoInfo = null;
  let datasetsDisponibles = [];
  let archivoActivo = "";
  let sidebarColapsado = false;

  try {
    sidebarColapsado = globalThis.localStorage?.getItem("horarios:sidebarColapsado") === "1";
  } catch {
    sidebarColapsado = false;
  }

  const els = {
    appShell: doc.getElementById("app-shell"),
    badgeSemestreActivo: doc.getElementById("badge-semestre-activo"),
    btnToggleSidebar: doc.getElementById("btn-toggle-sidebar"),
    labelToggleSidebar: doc.getElementById("label-toggle-sidebar"),
    datasetSelect: doc.getElementById("dataset-select"),
    panelInspector: doc.getElementById("panel-inspector"),
    btnCerrarInspector: doc.getElementById("btn-cerrar-inspector"),
    contadorCatalogo: doc.getElementById("contador-catalogo"),
    tabPanelMaterias: doc.getElementById("tab-panel-materias"),
    tabPanelFiltros: doc.getElementById("tab-panel-filtros"),
    tabPanelMotor: doc.getElementById("tab-panel-motor"),
    badgeFiltros: doc.getElementById("badge-filtros"),
    badgeMotor: doc.getElementById("badge-motor"),
    vistaPanelMaterias: doc.getElementById("vista-panel-materias"),
    vistaPanelFiltros: doc.getElementById("vista-panel-filtros"),
    vistaPanelMotor: doc.getElementById("vista-panel-motor"),
    textoResumenCatalogo: doc.getElementById("texto-resumen-catalogo"),
    btnIrFiltros: doc.getElementById("btn-ir-filtros"),
    btnAgruparGrupo: doc.getElementById("btn-agrupar-grupo"),
    btnAgruparMateria: doc.getElementById("btn-agrupar-materia"),
    filtroTexto: doc.getElementById("filtro-texto"),
    btnLimpiarTexto: doc.getElementById("btn-limpiar-texto"),
    filtroSemestreGrupo: doc.getElementById("filtro-semestre-grupo"),
    filtroDias: doc.getElementById("filtro-dias"),
    filtroHoraMin: doc.getElementById("filtro-hora-min"),
    filtroHoraMax: doc.getElementById("filtro-hora-max"),
    filtroTiposClase: doc.getElementById("filtro-tipos-clase"),
    filtroSoloCupo: doc.getElementById("filtro-solo-cupo"),
    filtroCupoMin: doc.getElementById("filtro-cupo-min"),
    inputExcluirProf: doc.getElementById("input-excluir-profesor"),
    btnExcluirProf: doc.getElementById("btn-excluir-profesor"),
    datalistProfesores: doc.getElementById("datalist-profesores"),
    listaProfExcluidos: doc.getElementById("lista-profesores-excluidos"),
    inputExcluirGrupo: doc.getElementById("input-excluir-grupo"),
    btnExcluirGrupo: doc.getElementById("btn-excluir-grupo"),
    datalistGrupos: doc.getElementById("datalist-grupos"),
    listaGruposExcluidos: doc.getElementById("lista-grupos-excluidos"),
    presetPreferencias: doc.getElementById("preset-preferencias"),
    prefHoraIdealInicio: doc.getElementById("pref-hora-ideal-inicio"),
    prefHoraIdealFin: doc.getElementById("pref-hora-ideal-fin"),
    pesoDiasLibres: doc.getElementById("peso-dias-libres"),
    valPesoDiasLibres: doc.getElementById("val-peso-dias-libres"),
    pesoHuecos: doc.getElementById("peso-huecos"),
    valPesoHuecos: doc.getElementById("val-peso-huecos"),
    pesoRango: doc.getElementById("peso-rango"),
    valPesoRango: doc.getElementById("val-peso-rango"),
    prefPermitirSolap: doc.getElementById("pref-permitir-solapamiento"),
    controlesTolerancia: doc.getElementById("controles-tolerancia"),
    prefToleranciaMin: doc.getElementById("pref-tolerancia-min"),
    chipsTolerancia: doc.getElementById("chips-tolerancia"),
    prefMaxCombinaciones: doc.getElementById("pref-max-combinaciones"),
    btnLimpiarFiltros: doc.getElementById("btn-limpiar-filtros"),
    catalogoMaterias: doc.getElementById("catalogo-materias"),
    contadorSeleccionadas: doc.getElementById("contador-seleccionadas"),
    listaSeleccionadas: doc.getElementById("lista-seleccionadas"),
    btnLimpiarSeleccion: doc.getElementById("btn-limpiar-seleccion"),
    btnGenerarTop: doc.getElementById("btn-generar-top"),
    btnGenerarMain: doc.getElementById("btn-generar-main"),
    seccionRecomendaciones: doc.getElementById("seccion-recomendaciones"),
    telemetryRecomendaciones: doc.getElementById("telemetry-recomendaciones"),
    panelDiagnostico: doc.getElementById("panel-diagnostico"),
    gridRecomendaciones: doc.getElementById("grid-recomendaciones"),
    recsFooter: doc.getElementById("recs-footer"),
    btnVerMasRecs: doc.getElementById("btn-ver-mas-recs"),
    seccionGrilla: doc.getElementById("seccion-grilla"),
    tabModoRecomendado: doc.getElementById("tab-modo-recomendado"),
    tabModoManual: doc.getElementById("tab-modo-manual"),
    btnNavManual: doc.getElementById("btn-nav-manual"),
    studioTitulo: doc.getElementById("studio-titulo"),
    studioKpis: doc.getElementById("studio-kpis"),
    btnExportarPdf: doc.getElementById("btn-exportar-pdf"),
    btnExportarPng: doc.getElementById("btn-exportar-png"),
    bannerAdvertencias: doc.getElementById("banner-advertencias"),
    panelManual: doc.getElementById("panel-manual"),
    grillaSemanal: doc.getElementById("grilla-semanal"),
    inspectorBloque: doc.getElementById("inspector-bloque"),
    leyendaImpresion: doc.getElementById("leyenda-impresion"),
    footerDatasetInfo: doc.getElementById("footer-dataset-info"),
  };

  poblarSelectHoras(els.filtroHoraMin, true, "Sin mín.");
  poblarSelectHoras(els.filtroHoraMax, true, "Sin máx.");
  poblarSelectHoras(els.prefHoraIdealInicio, false, "", 420);
  poblarSelectHoras(els.prefHoraIdealFin, false, "", 1320);

  const obtenerHorarioActivo = (estado) => {
    if (modoVista === "manual") {
      return ctrl.construirHorarioManual();
    }
    const recs = estado.resultadoRecomendaciones?.recomendaciones || [];
    if (recs.length === 0) {
      return null;
    }
    return recs.find((r) => r.id === estado.recomendacionActivaId) || recs[0];
  };

  const sincronizarControlesPreferencias = (estado) => {
    const p = estado.preferencias;
    if (els.presetPreferencias) {
      for (const btn of els.presetPreferencias.querySelectorAll("[data-preset]")) {
        btn.classList.toggle("is-active", btn.dataset.preset === p.preset);
      }
    }
    if (els.prefHoraIdealInicio) {
      els.prefHoraIdealInicio.value = String(p.horaIdealInicioMin);
    }
    if (els.prefHoraIdealFin) {
      els.prefHoraIdealFin.value = String(p.horaIdealFinMin);
    }
    if (els.pesoDiasLibres) {
      els.pesoDiasLibres.value = String(p.pesos.diasLibres);
      if (els.valPesoDiasLibres) els.valPesoDiasLibres.textContent = String(p.pesos.diasLibres);
    }
    if (els.pesoHuecos) {
      els.pesoHuecos.value = String(p.pesos.huecos);
      if (els.valPesoHuecos) els.valPesoHuecos.textContent = String(p.pesos.huecos);
    }
    if (els.pesoRango) {
      els.pesoRango.value = String(p.pesos.rangoHorario);
      if (els.valPesoRango) els.valPesoRango.textContent = String(p.pesos.rangoHorario);
    }
    if (els.prefMaxCombinaciones) {
      els.prefMaxCombinaciones.value = String(p.maxCombinacionesEvaluadas);
    }
    if (els.prefPermitirSolap) {
      els.prefPermitirSolap.checked = Boolean(p.permitirSolapamiento);
    }
    if (els.controlesTolerancia) {
      els.controlesTolerancia.hidden = !p.permitirSolapamiento;
    }
    if (els.prefToleranciaMin) {
      if (p.toleranciaSolapamientoMin === null) {
        els.prefToleranciaMin.value = "";
        els.prefToleranciaMin.placeholder = "∞";
      } else if (Number.isFinite(p.toleranciaSolapamientoMin)) {
        els.prefToleranciaMin.value = String(p.toleranciaSolapamientoMin);
        els.prefToleranciaMin.placeholder = "30";
      }
    }
    if (els.chipsTolerancia) {
      const tolActual =
        p.toleranciaSolapamientoMin === null ? "sin-limite" : String(p.toleranciaSolapamientoMin);
      for (const btn of els.chipsTolerancia.querySelectorAll("[data-tolerancia]")) {
        btn.classList.toggle("is-active", btn.dataset.tolerancia === tolActual);
      }
    }
  };

  const sincronizarVista = (estado = ctrl.obtenerEstado()) => {
    const filtrados = ctrl.obtenerHorariosFiltrados();
    const materiasAgrupadas = ctrl.obtenerMateriasFiltradas();
    const gruposAgrupados = ctrl.obtenerGruposFiltrados();
    const catalogos = ctrl.obtenerCatalogos();

    const mapaNombres = new Map();
    for (const r of estado.horarios) {
      if (r.clv_materia && !mapaNombres.has(r.clv_materia)) {
        mapaNombres.set(r.clv_materia, r.materia || r.clv_materia);
      }
    }

    if (els.contadorCatalogo) {
      els.contadorCatalogo.textContent =
        modoCatalogo === "grupo"
          ? `${gruposAgrupados.length} grupos · ${materiasAgrupadas.length} materias`
          : `${materiasAgrupadas.length} materias · ${filtrados.length} grupos`;
    }

    const totalFiltrosActivos = contarFiltrosActivos(estado.filtros);
    if (els.badgeFiltros) {
      els.badgeFiltros.hidden = totalFiltrosActivos === 0;
      els.badgeFiltros.textContent = String(totalFiltrosActivos);
    }
    if (els.btnIrFiltros) {
      els.btnIrFiltros.hidden = totalFiltrosActivos === 0;
      els.btnIrFiltros.textContent = `${totalFiltrosActivos} ${
        totalFiltrosActivos === 1 ? "filtro activo" : "filtros activos"
      } →`;
    }
    if (els.badgeMotor) {
      const motorAlterado =
        estado.preferencias.permitirSolapamiento ||
        estado.preferencias.preset !== "balanceado";
      els.badgeMotor.hidden = !motorAlterado;
      els.badgeMotor.textContent = estado.preferencias.permitirSolapamiento ? "⚠" : "•";
    }
    if (els.textoResumenCatalogo) {
      const semActivo = estado.filtros.semestresGrupo?.[0];
      els.textoResumenCatalogo.textContent = estado.filtros.texto
        ? `Resultados para "${estado.filtros.texto}"`
        : semActivo
        ? `Filtrado: ${formatearEtiquetaSemestre(semActivo)}`
        : modoCatalogo === "grupo"
        ? "Expande un grupo o elige todas sus materias"
        : "Clic en una materia para seleccionarla";
    }

    renderizarSelectSemestres(
      els.filtroSemestreGrupo,
      catalogos.semestresGrupo,
      estado.filtros.semestresGrupo
    );

    if (els.btnLimpiarTexto) {
      els.btnLimpiarTexto.hidden = !estado.filtros.texto;
    }
    if (els.filtroTexto && els.filtroTexto.value !== estado.filtros.texto) {
      els.filtroTexto.value = estado.filtros.texto;
    }

    if (els.filtroDias) {
      const activos = estado.filtros.diasActivos
        ? new Set(estado.filtros.diasActivos)
        : new Set(DIAS_SEMANA);
      for (const btn of els.filtroDias.querySelectorAll("[data-dia]")) {
        const activo = activos.has(btn.dataset.dia);
        btn.classList.toggle("is-active", activo);
        btn.setAttribute("aria-pressed", String(activo));
      }
    }

    if (els.filtroHoraMin) {
      els.filtroHoraMin.value =
        estado.filtros.horaMinInicio !== null ? String(estado.filtros.horaMinInicio) : "";
    }
    if (els.filtroHoraMax) {
      els.filtroHoraMax.value =
        estado.filtros.horaMaxFin !== null ? String(estado.filtros.horaMaxFin) : "";
    }
    if (els.filtroSoloCupo) {
      els.filtroSoloCupo.checked = Boolean(estado.filtros.soloConCupo);
    }
    if (els.filtroCupoMin) {
      els.filtroCupoMin.value =
        estado.filtros.cupoMinimo !== null ? String(estado.filtros.cupoMinimo) : "";
    }

    renderizarCatalogoFiltros(
      {
        tiposClaseEl: els.filtroTiposClase,
        datalistProfesoresEl: els.datalistProfesores,
        datalistGruposEl: els.datalistGrupos,
        profesoresExcluidosEl: els.listaProfExcluidos,
        gruposExcluidosEl: els.listaGruposExcluidos,
      },
      catalogos,
      estado.filtros
    );

    sincronizarControlesPreferencias(estado);

    const esPorGrupo = modoCatalogo === "grupo";
    if (els.btnAgruparGrupo) {
      els.btnAgruparGrupo.classList.toggle("is-active", esPorGrupo);
      els.btnAgruparGrupo.setAttribute("aria-pressed", String(esPorGrupo));
    }
    if (els.btnAgruparMateria) {
      els.btnAgruparMateria.classList.toggle("is-active", !esPorGrupo);
      els.btnAgruparMateria.setAttribute("aria-pressed", String(!esPorGrupo));
    }

    if (esPorGrupo) {
      renderizarCatalogoPorGrupo(
        els.catalogoMaterias,
        gruposAgrupados,
        estado,
        gruposExpandidos,
        Boolean(estado.filtros.texto)
      );
    } else {
      renderizarCatalogoMaterias(
        els.catalogoMaterias,
        materiasAgrupadas,
        estado,
        materiasExpandidas
      );
    }

    renderizarMateriasSeleccionadas(
      els.listaSeleccionadas,
      els.contadorSeleccionadas,
      estado,
      mapaNombres
    );

    renderizarDiagnostico(
      els.panelDiagnostico,
      estado.resultadoRecomendaciones?.diagnostico || null
    );

    renderizarRecomendaciones(
      els.gridRecomendaciones,
      els.recsFooter,
      els.telemetryRecomendaciones,
      estado.resultadoRecomendaciones,
      estado.recomendacionActivaId,
      limiteVisibleRecs
    );

    const esManual = modoVista === "manual";
    if (els.tabModoRecomendado) {
      els.tabModoRecomendado.classList.toggle("is-active", !esManual);
      els.tabModoRecomendado.setAttribute("aria-selected", String(!esManual));
    }
    if (els.tabModoManual) {
      els.tabModoManual.classList.toggle("is-active", esManual);
      els.tabModoManual.setAttribute("aria-selected", String(esManual));
    }
    if (els.panelManual) {
      els.panelManual.hidden = !esManual;
      if (esManual) {
        const filtradosManual = filtrarHorarios(estado.horarios, {
          ...estado.filtros,
          texto: "",
          semestresGrupo: [],
        });
        renderizarComparadorManual(
          els.panelManual,
          estado.materiasSeleccionadas,
          filtradosManual,
          estado.horarios,
          estado.seleccionManual
        );
      }
    }

    const horarioActivo = obtenerHorarioActivo(estado);
    renderizarGrillaSemanal(
      {
        grillaEl: els.grillaSemanal,
        tituloEl: els.studioTitulo,
        kpisEl: els.studioKpis,
        bannerAdvertenciasEl: els.bannerAdvertencias,
        leyendaImpresionEl: els.leyendaImpresion,
      },
      horarioActivo,
      bloqueInspectorId
    );

    const regInspectado =
      horarioActivo?.registros?.find(
        (r) => (r.id || `${r.clv_materia}:${r.grupo}`) === registroInspectorId
      ) || null;
    renderizarInspectorBloque(els.inspectorBloque, regInspectado);

    if (els.footerDatasetInfo) {
      const m = estado.metadata;
      els.footerDatasetInfo.textContent = m
        ? `${m.etiqueta_semestre || m.semestre} · ${m.nombre_carrera || `CARR ${m.carrera}`} · ${
            m.total_registros ?? estado.horarios.length
          } REGISTROS`
        : `${estado.horarios.length} REGISTROS CARGADOS`;
    }
  };

  const recalcularRecomendaciones = () => {
    limiteVisibleRecs = 6;
    bloqueInspectorId = "";
    registroInspectorId = "";
    const estado = ctrl.obtenerEstado();
    if (estado.materiasSeleccionadas.length === 0) {
      ctrl.limpiarMateriasSeleccionadas();
      return;
    }
    ctrl.generarHorariosRecomendados();
  };

  const cambiarModoVista = (nuevoModo) => {
    modoVista = nuevoModo;
    if (nuevoModo === "manual") {
      const estado = ctrl.obtenerEstado();
      if (estado.seleccionManual.length === 0) {
        const recs = estado.resultadoRecomendaciones?.recomendaciones || [];
        const base = recs.find((r) => r.id === estado.recomendacionActivaId) || recs[0];
        if (base) {
          ctrl.construirHorarioManual(base.registros);
          return;
        }
      }
    }
    sincronizarVista();
  };

  // Suscripción reactiva del controlador hacia la vista
  ctrl.suscribir(sincronizarVista);

  // Eventos: cambio de carrera
  els.datasetSelect?.addEventListener("change", async (e) => {
    const archivo = e.target.value;
    if (!archivo) return;
    archivoActivo = archivo;
    bloqueInspectorId = "";
    registroInspectorId = "";
    materiasExpandidas.clear();
    gruposExpandidos.clear();
    try {
      globalThis.localStorage?.setItem("horarios:carrera", archivo);
    } catch {
      // Ignora si el almacenamiento local no está disponible
    }
    await ctrl.cargarDatos(`${baseDataUrl}/${archivo}`);
    ctrl.actualizarFiltros({ semestresGrupo: [] });
  });

  // Eventos: pestañas del configurador (01 MATERIAS / 02 FILTROS / 03 MOTOR)
  const cambiarTabPanel = (tab) => {
    tabPanelActivo = tab;
    const mapa = [
      ["materias", els.tabPanelMaterias, els.vistaPanelMaterias],
      ["filtros", els.tabPanelFiltros, els.vistaPanelFiltros],
      ["motor", els.tabPanelMotor, els.vistaPanelMotor],
    ];
    for (const [clave, btn, panel] of mapa) {
      const activo = clave === tab;
      btn?.classList.toggle("is-active", activo);
      btn?.setAttribute("aria-selected", String(activo));
      if (panel) panel.hidden = !activo;
    }
  };
  for (const btn of [els.tabPanelMaterias, els.tabPanelFiltros, els.tabPanelMotor]) {
    btn?.addEventListener("click", () => {
      if (btn.dataset.panelTab) cambiarTabPanel(btn.dataset.panelTab);
    });
  }
  els.btnIrFiltros?.addEventListener("click", () => cambiarTabPanel("filtros"));

  // Eventos: búsqueda de texto libre
  let timerTexto = null;
  els.filtroTexto?.addEventListener("input", (e) => {
    const valor = e.target.value;
    clearTimeout(timerTexto);
    timerTexto = setTimeout(() => {
      ctrl.actualizarFiltros({ texto: valor });
    }, 90);
  });

  els.btnLimpiarTexto?.addEventListener("click", () => {
    if (els.filtroTexto) els.filtroTexto.value = "";
    ctrl.actualizarFiltros({ texto: "" });
  });

  // Eventos: filtro de semestre por código de grupo
  els.filtroSemestreGrupo?.addEventListener("change", (e) => {
    const val = e.target.value;
    ctrl.actualizarFiltros({
      semestresGrupo: val ? [Number(val)] : [],
    });
  });

  // Eventos: días activos
  els.filtroDias?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-dia]");
    if (!btn) return;
    const estado = ctrl.obtenerEstado();
    const actuales = new Set(estado.filtros.diasActivos || DIAS_SEMANA);
    const dia = btn.dataset.dia;
    if (actuales.has(dia)) {
      if (actuales.size <= 1) return; // Evita dejar 0 días activos
      actuales.delete(dia);
    } else {
      actuales.add(dia);
    }
    const nuevaLista = DIAS_SEMANA.filter((d) => actuales.has(d));
    ctrl.actualizarFiltros({
      diasActivos: nuevaLista.length === DIAS_SEMANA.length ? null : nuevaLista,
    });
    recalcularRecomendaciones();
  });

  // Eventos: rango horario, cupo y modalidad
  els.filtroHoraMin?.addEventListener("change", (e) => {
    ctrl.actualizarFiltros({
      horaMinInicio: e.target.value ? Number(e.target.value) : null,
    });
    recalcularRecomendaciones();
  });

  els.filtroHoraMax?.addEventListener("change", (e) => {
    ctrl.actualizarFiltros({
      horaMaxFin: e.target.value ? Number(e.target.value) : null,
    });
    recalcularRecomendaciones();
  });

  els.filtroSoloCupo?.addEventListener("change", (e) => {
    ctrl.actualizarFiltros({ soloConCupo: e.target.checked });
    recalcularRecomendaciones();
  });

  els.filtroCupoMin?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    ctrl.actualizarFiltros({ cupoMinimo: val === "" ? null : Number(val) });
    recalcularRecomendaciones();
  });

  els.filtroTiposClase?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tipo-clase]");
    if (!btn) return;
    const tipo = btn.dataset.tipoClase;
    const actuales = new Set(ctrl.obtenerEstado().filtros.tiposClase);
    if (actuales.has(tipo)) {
      actuales.delete(tipo);
    } else {
      actuales.add(tipo);
    }
    ctrl.actualizarFiltros({ tiposClase: Array.from(actuales) });
    recalcularRecomendaciones();
  });

  // Eventos: exclusiones
  const agregarExclusionProfesor = () => {
    const nombre = els.inputExcluirProf?.value.trim();
    if (!nombre) return;
    ctrl.excluirProfesor(nombre);
    els.inputExcluirProf.value = "";
    recalcularRecomendaciones();
  };
  els.btnExcluirProf?.addEventListener("click", agregarExclusionProfesor);
  els.inputExcluirProf?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      agregarExclusionProfesor();
    }
  });

  const agregarExclusionGrupo = () => {
    const grupo = els.inputExcluirGrupo?.value.trim();
    if (!grupo) return;
    ctrl.excluirGrupo(grupo);
    els.inputExcluirGrupo.value = "";
    recalcularRecomendaciones();
  };
  els.btnExcluirGrupo?.addEventListener("click", agregarExclusionGrupo);
  els.inputExcluirGrupo?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      agregarExclusionGrupo();
    }
  });

  els.listaProfExcluidos?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-quitar-profesor]");
    if (!btn) return;
    ctrl.quitarProfesorExcluido(btn.dataset.quitarProfesor);
    recalcularRecomendaciones();
  });

  els.listaGruposExcluidos?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-quitar-grupo]");
    if (!btn) return;
    ctrl.quitarGrupoExcluido(btn.dataset.quitarGrupo);
    recalcularRecomendaciones();
  });

  // Eventos: preferencias, pesos y tolerancia de solapamiento
  els.presetPreferencias?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    ctrl.aplicarPresetPreferencias(btn.dataset.preset);
    recalcularRecomendaciones();
  });

  els.prefHoraIdealInicio?.addEventListener("change", (e) => {
    ctrl.actualizarPreferencias({
      horaIdealInicioMin: Number(e.target.value),
      preset: "personalizado",
    });
    recalcularRecomendaciones();
  });

  els.prefHoraIdealFin?.addEventListener("change", (e) => {
    ctrl.actualizarPreferencias({
      horaIdealFinMin: Number(e.target.value),
      preset: "personalizado",
    });
    recalcularRecomendaciones();
  });

  const enlazarSliderPeso = (sliderEl, clavePeso) => {
    sliderEl?.addEventListener("input", (e) => {
      ctrl.actualizarPreferencias({
        preset: "personalizado",
        pesos: { [clavePeso]: Number(e.target.value) },
      });
      recalcularRecomendaciones();
    });
  };
  enlazarSliderPeso(els.pesoDiasLibres, "diasLibres");
  enlazarSliderPeso(els.pesoHuecos, "huecos");
  enlazarSliderPeso(els.pesoRango, "rangoHorario");

  els.prefMaxCombinaciones?.addEventListener("change", (e) => {
    ctrl.actualizarPreferencias({
      maxCombinacionesEvaluadas: Number(e.target.value),
    });
    recalcularRecomendaciones();
  });

  els.prefPermitirSolap?.addEventListener("change", (e) => {
    const permitir = e.target.checked;
    const actualTol = ctrl.obtenerEstado().preferencias.toleranciaSolapamientoMin;
    ctrl.actualizarPreferencias({
      permitirSolapamiento: permitir,
      toleranciaSolapamientoMin:
        permitir && actualTol === 0 ? 30 : permitir ? actualTol : 0,
    });
    recalcularRecomendaciones();
  });

  els.prefToleranciaMin?.addEventListener("input", (e) => {
    const val = Math.max(0, Number(e.target.value) || 0);
    ctrl.actualizarPreferencias({
      permitirSolapamiento: true,
      toleranciaSolapamientoMin: val,
    });
    recalcularRecomendaciones();
  });

  els.chipsTolerancia?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tolerancia]");
    if (!btn) return;
    const raw = btn.dataset.tolerancia;
    const tol = raw === "sin-limite" ? null : Number(raw);
    ctrl.actualizarPreferencias({
      permitirSolapamiento: true,
      toleranciaSolapamientoMin: tol,
    });
    recalcularRecomendaciones();
  });

  els.btnLimpiarFiltros?.addEventListener("click", () => {
    ctrl.limpiarFiltros();
    recalcularRecomendaciones();
  });

  els.btnAgruparGrupo?.addEventListener("click", () => {
    modoCatalogo = "grupo";
    sincronizarVista();
  });

  els.btnAgruparMateria?.addEventListener("click", () => {
    modoCatalogo = "materia";
    sincronizarVista();
  });

  // Eventos: catálogo de materias y grupos
  els.catalogoMaterias?.addEventListener("click", (e) => {
    const expandGrupoBtn = e.target.closest("[data-expand-grupo]");
    if (expandGrupoBtn) {
      const grp = expandGrupoBtn.dataset.expandGrupo;
      if (gruposExpandidos.has(grp)) {
        gruposExpandidos.delete(grp);
      } else {
        gruposExpandidos.add(grp);
      }
      sincronizarVista();
      return;
    }

    const toggleGrupoBtn = e.target.closest("[data-toggle-grupo-completo]");
    if (toggleGrupoBtn) {
      const clavesGrupo = String(toggleGrupoBtn.dataset.claves || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      if (clavesGrupo.length === 0) return;

      const actuales = ctrl.obtenerEstado().materiasSeleccionadas;
      const setActuales = new Set(actuales);
      const todasElegidas = clavesGrupo.every((c) => setActuales.has(c));

      if (todasElegidas) {
        const setGrupo = new Set(clavesGrupo);
        ctrl.seleccionarMaterias(actuales.filter((c) => !setGrupo.has(c)));
      } else {
        ctrl.seleccionarMaterias([...actuales, ...clavesGrupo]);
      }
      recalcularRecomendaciones();
      return;
    }

    const toggleBtn = e.target.closest("[data-toggle-materia]");
    if (toggleBtn) {
      ctrl.alternarMateriaSeleccionada(toggleBtn.dataset.toggleMateria);
      recalcularRecomendaciones();
      return;
    }

    const expandBtn = e.target.closest("[data-expand-materia]");
    if (expandBtn) {
      const clave = expandBtn.dataset.expandMateria;
      if (materiasExpandidas.has(clave)) {
        materiasExpandidas.delete(clave);
      } else {
        materiasExpandidas.add(clave);
      }
      sincronizarVista();
      return;
    }

    const exclProfBtn = e.target.closest("[data-excluir-profesor]");
    if (exclProfBtn) {
      ctrl.excluirProfesor(exclProfBtn.dataset.excluirProfesor);
      recalcularRecomendaciones();
      return;
    }

    const exclGrpBtn = e.target.closest("[data-excluir-grupo]");
    if (exclGrpBtn) {
      ctrl.excluirGrupo(exclGrpBtn.dataset.excluirGrupo);
      recalcularRecomendaciones();
      return;
    }

    const fijarManualBtn = e.target.closest("[data-fijar-manual]");
    if (fijarManualBtn) {
      const idBuscado = fijarManualBtn.dataset.fijarManual;
      const estado = ctrl.obtenerEstado();
      const registro = estado.horarios.find(
        (r) => (r.id || `${r.clv_materia}:${r.grupo}`) === idBuscado
      );
      if (registro) {
        if (!estado.materiasSeleccionadas.includes(registro.clv_materia)) {
          ctrl.alternarMateriaSeleccionada(registro.clv_materia);
        }
        const manualSinMateria = estado.seleccionManual.filter(
          (r) => r.clv_materia !== registro.clv_materia
        );
        modoVista = "manual";
        ctrl.construirHorarioManual([...manualSinMateria, registro]);
        els.seccionGrilla?.scrollIntoView({ behavior: "smooth" });
      }
    }
  });

  // Eventos: chips de materias seleccionadas
  els.listaSeleccionadas?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-quitar-materia]");
    if (!btn) return;
    ctrl.alternarMateriaSeleccionada(btn.dataset.quitarMateria);
    recalcularRecomendaciones();
  });

  els.btnLimpiarSeleccion?.addEventListener("click", () => {
    ctrl.limpiarMateriasSeleccionadas();
    ctrl.construirHorarioManual([]);
  });

  const dispararGeneracionConScroll = () => {
    modoVista = "recomendado";
    recalcularRecomendaciones();
    els.seccionRecomendaciones?.scrollIntoView({ behavior: "smooth" });
  };
  els.btnGenerarTop?.addEventListener("click", dispararGeneracionConScroll);
  els.btnGenerarMain?.addEventListener("click", dispararGeneracionConScroll);

  // Eventos: recomendaciones y diagnóstico
  els.gridRecomendaciones?.addEventListener("click", (e) => {
    const card = e.target.closest("[data-seleccionar-rec]");
    if (!card) return;
    modoVista = "recomendado";
    bloqueInspectorId = "";
    registroInspectorId = "";
    ctrl.seleccionarRecomendacion(card.dataset.seleccionarRec);
  });

  els.btnVerMasRecs?.addEventListener("click", () => {
    limiteVisibleRecs += 6;
    sincronizarVista();
  });

  els.panelDiagnostico?.addEventListener("click", (e) => {
    const btnTol = e.target.closest('[data-action="activar-tolerancia"]');
    if (btnTol) {
      const minutos = Number(btnTol.dataset.minutos) || 30;
      ctrl.actualizarPreferencias({
        permitirSolapamiento: true,
        toleranciaSolapamientoMin: minutos,
      });
      recalcularRecomendaciones();
      return;
    }

    if (e.target.closest('[data-action="limpiar-filtros-diag"]')) {
      ctrl.limpiarFiltros();
      recalcularRecomendaciones();
    }
  });

  // Eventos: tabs de estudio y comparador manual
  els.tabModoRecomendado?.addEventListener("click", () =>
    cambiarModoVista("recomendado")
  );
  els.tabModoManual?.addEventListener("click", () => cambiarModoVista("manual"));
  els.btnNavManual?.addEventListener("click", () => {
    cambiarModoVista("manual");
    els.seccionGrilla?.scrollIntoView({ behavior: "smooth" });
  });

  els.panelManual?.addEventListener("change", (e) => {
    const select = e.target.closest("[data-manual-materia]");
    if (!select) return;
    const clave = select.dataset.manualMateria;
    const idSeleccionado = select.value;
    const estado = ctrl.obtenerEstado();

    const restantes = estado.seleccionManual.filter(
      (r) => r.clv_materia !== clave
    );
    if (idSeleccionado) {
      const elegido = estado.horarios.find(
        (r) => (r.id || `${r.clv_materia}:${r.grupo}`) === idSeleccionado
      );
      if (elegido) {
        restantes.push(elegido);
      }
    }
    ctrl.construirHorarioManual(restantes);
  });

  // Eventos: inspector de bloques en la grilla
  els.grillaSemanal?.addEventListener("click", (e) => {
    const bloqueBtn = e.target.closest("[data-inspeccionar-bloque]");
    if (!bloqueBtn) return;
    bloqueInspectorId = bloqueBtn.dataset.inspeccionarBloque || "";
    registroInspectorId = bloqueBtn.dataset.registroId || "";
    sincronizarVista();
  });

  els.inspectorBloque?.addEventListener("click", (e) => {
    if (e.target.closest("[data-cerrar-inspector-bloque]")) {
      bloqueInspectorId = "";
      registroInspectorId = "";
      sincronizarVista();
      return;
    }

    const exclProf = e.target.closest("[data-excluir-profesor]");
    if (exclProf) {
      ctrl.excluirProfesor(exclProf.dataset.excluirProfesor);
      bloqueInspectorId = "";
      registroInspectorId = "";
      recalcularRecomendaciones();
      return;
    }

    const exclGrp = e.target.closest("[data-excluir-grupo]");
    if (exclGrp) {
      ctrl.excluirGrupo(exclGrp.dataset.excluirGrupo);
      bloqueInspectorId = "";
      registroInspectorId = "";
      recalcularRecomendaciones();
    }
  });

  // Eventos: exportación PDF y PNG
  els.btnExportarPdf?.addEventListener("click", () => {
    if (typeof globalThis.print === "function") {
      globalThis.print();
    }
  });

  els.btnExportarPng?.addEventListener("click", () => {
    const estado = ctrl.obtenerEstado();
    const horarioActivo = obtenerHorarioActivo(estado);
    exportarHorarioPNG(horarioActivo, estado.metadata);
  });

  // Barra lateral colapsable (escritorio y móvil)
  const esVistaMovil = () =>
    typeof globalThis.innerWidth === "number" && globalThis.innerWidth <= 1024;

  const aplicarEstadoSidebar = () => {
    const movil = esVistaMovil();
    if (movil) {
      els.appShell?.classList.remove("is-sidebar-collapsed");
      const abiertoMovil = Boolean(els.panelInspector?.classList.contains("is-open"));
      els.btnToggleSidebar?.setAttribute("aria-expanded", String(abiertoMovil));
      if (els.labelToggleSidebar) {
        els.labelToggleSidebar.textContent = abiertoMovil ? "OCULTAR PANEL" : "ABRIR PANEL";
      }
    } else {
      els.panelInspector?.classList.remove("is-open");
      els.appShell?.classList.toggle("is-sidebar-collapsed", sidebarColapsado);
      els.btnToggleSidebar?.setAttribute("aria-expanded", String(!sidebarColapsado));
      if (els.labelToggleSidebar) {
        els.labelToggleSidebar.textContent = sidebarColapsado ? "ABRIR PANEL" : "OCULTAR PANEL";
      }
    }
  };

  aplicarEstadoSidebar();

  els.btnToggleSidebar?.addEventListener("click", () => {
    if (esVistaMovil()) {
      els.panelInspector?.classList.toggle("is-open");
    } else {
      sidebarColapsado = !sidebarColapsado;
      try {
        globalThis.localStorage?.setItem(
          "horarios:sidebarColapsado",
          sidebarColapsado ? "1" : "0"
        );
      } catch {
        // Ignora errores de almacenamiento
      }
    }
    aplicarEstadoSidebar();
  });

  els.btnCerrarInspector?.addEventListener("click", () => {
    if (esVistaMovil()) {
      els.panelInspector?.classList.remove("is-open");
    } else {
      sidebarColapsado = true;
      try {
        globalThis.localStorage?.setItem("horarios:sidebarColapsado", "1");
      } catch {
        // Ignora errores de almacenamiento
      }
    }
    aplicarEstadoSidebar();
  });

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("resize", aplicarEstadoSidebar);
  }

  // Carga inicial de índice de carreras (último semestre) y selección predeterminada
  try {
    const indice = await cargarIndiceDatasets();
    baseDataUrl = indice.baseUrl;
    semestreActivoInfo = indice.semestreActivo;
    datasetsDisponibles = indice.datasets;

    let preferido = "";
    try {
      preferido = globalThis.localStorage?.getItem("horarios:carrera") || "";
    } catch {
      preferido = "";
    }

    const existePreferido = datasetsDisponibles.some((d) => d.archivo === preferido);
    const porDefectoCompu = datasetsDisponibles.find(
      (d) => d.archivo === "sem_35_carr_12.json" || String(d.carrera) === "12"
    );
    archivoActivo = existePreferido
      ? preferido
      : porDefectoCompu?.archivo || datasetsDisponibles[0]?.archivo || "sem_35_carr_12.json";

    renderizarSelectDatasets(
      els.datasetSelect,
      datasetsDisponibles,
      archivoActivo,
      els.badgeSemestreActivo,
      semestreActivoInfo
    );
    await ctrl.cargarDatos(`${baseDataUrl}/${archivoActivo}`);
  } catch (err) {
    if (els.telemetryRecomendaciones) {
      els.telemetryRecomendaciones.textContent = "ERROR AL CARGAR DATOS";
    }
    if (els.catalogoMaterias) {
      els.catalogoMaterias.innerHTML = `<div class="rec-empty-cell">No se pudieron cargar los horarios (${err.message}). Sirve el proyecto desde un servidor estático (por ejemplo, <code>python -m http.server</code>).</div>`;
    }
  }

  return ctrl;
}

if (typeof document !== "undefined" && document.getElementById("app-horarios")) {
  iniciarAplicacionWeb(document);
}
