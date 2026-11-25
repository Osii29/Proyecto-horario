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
  obtenerPesoEnLineaRegistro,
  obtenerSemestreDeGrupo,
} from "./scheduler.js";
import {
  asignarColorMateria,
  construirMapaColoresMaterias,
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
  renderizarSkeletonCatalogo,
} from "./render.js";

export { formatearEtiquetaSemestre, obtenerSemestreDeGrupo };

export const FILTROS_POR_DEFECTO = Object.freeze({
  texto: "",
  semestresGrupo: [], // vacío = todos los semestres; array de enteros 1..10
  diasActivos: null, // null = sin restricción de días; array = solo bloques dentro de estos días
  horaMinInicio: null, // minutos o "HH:MM"
  horaMaxFin: null, // minutos o "HH:MM"
  tiposClase: [], // vacío = todas las modalidades
  soloPresenciales: false,
  soloConCupo: false,
  cupoMinimo: null,
  profesoresExcluidos: [],
  gruposExcluidos: [],
  materiasExcluidas: [],
  incluirSinHorario: true,
});

export const PREFERENCIAS_POR_DEFECTO = Object.freeze({
  preset: "balanceado",
  preferenciaModalidad: "indistinto", // "indistinto" | "preferirEnLinea" | "soloPresenciales"
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
        const tipoBloque = String(r.tipo_clase || "").trim();
        const salonBloque = String(r.salon || "").trim();
        for (const b of r.bloques) {
          const bKey = `${b.dia}|${b.inicio_min}|${b.fin_min}|${b.hora_texto}`;
          if (!bloqueKeys.has(bKey)) {
            bloqueKeys.add(bKey);
            const bloqueConMeta = { ...b };
            if (tipoBloque && !bloqueConMeta.tipo_clase) {
              bloqueConMeta.tipo_clase = tipoBloque;
            }
            if (salonBloque && !bloqueConMeta.salon) {
              bloqueConMeta.salon = salonBloque;
            }
            bloquesUnicos.push(bloqueConMeta);
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
    gruposSeleccionadosPorMateria: {},
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

/**
 * Indica si un grupo específico está habilitado para una materia seleccionada.
 * Si la materia no tiene lista de grupos específica, todos sus grupos participan.
 */
export function estaGrupoSeleccionadoParaMateria(estado, claveMateria, grupo) {
  const clave = String(claveMateria || "").trim();
  const grp = String(grupo || "").trim();
  if (!clave || !grp) {
    return false;
  }
  const seleccionadas = estado?.materiasSeleccionadas || [];
  if (!seleccionadas.includes(clave)) {
    return false;
  }
  const lista = estado?.gruposSeleccionadosPorMateria?.[clave];
  if (!Array.isArray(lista) || lista.length === 0) {
    return true;
  }
  return lista.includes(grp);
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

  const soloPresenciales = Boolean(filtros.soloPresenciales);
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

    const profRaw = String(registro.profesor || "");
    const profNorm = normalizarTexto(profRaw);
    if (profNorm) {
      const profPartes = profRaw.split("/").map(normalizarTexto).filter(Boolean);
      if (
        profesoresExcluidos.has(profNorm) ||
        profPartes.some((p) => profesoresExcluidos.has(p))
      ) {
        return false;
      }
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
      const tipoRaw = String(registro.tipo_clase || "");
      const tipoNorm = normalizarTexto(tipoRaw);
      const tipoPartes = tipoRaw.split("/").map(normalizarTexto).filter(Boolean);
      if (!tiposClase.has(tipoNorm) && !tipoPartes.some((t) => tiposClase.has(t))) {
        return false;
      }
    }

    if (soloPresenciales) {
      if (obtenerPesoEnLineaRegistro(registro) > 0) {
        return false;
      }
      const tipoPartes = String(registro.tipo_clase || "")
        .split("/")
        .map(normalizarTexto)
        .filter(Boolean);
      if (tipoPartes.length === 0 || !tipoPartes.every((t) => t === "presencial")) {
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
      for (const parte of String(registro.tipo_clase).split("/")) {
        const limpia = parte.trim();
        if (limpia) {
          tiposClase.add(limpia);
        }
      }
    }
    if (registro.profesor) {
      for (const parte of String(registro.profesor).split("/")) {
        const limpio = parte.trim();
        if (limpio) {
          profesores.add(limpio);
        }
      }
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
    const gruposClonados = {};
    for (const [clv, gpos] of Object.entries(
      estado.gruposSeleccionadosPorMateria || {}
    )) {
      if (Array.isArray(gpos) && gpos.length > 0) {
        gruposClonados[clv] = [...gpos];
      }
    }

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
      gruposSeleccionadosPorMateria: gruposClonados,
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
    estado.gruposSeleccionadosPorMateria = {};
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
    estado.gruposSeleccionadosPorMateria = {};
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
      delete estado.gruposSeleccionadosPorMateria[clave];
    } else {
      estado.materiasSeleccionadas = [...estado.materiasSeleccionadas, clave];
      delete estado.gruposSeleccionadosPorMateria[clave];
    }
    notificar();
  }

  function obtenerGruposDisponiblesDeMateria(claveMateria) {
    const vistos = new Set();
    const grupos = [];
    for (const r of estado.horarios) {
      if (String(r.clv_materia || "").trim() === claveMateria) {
        const g = String(r.grupo || "").trim();
        if (g && !vistos.has(g)) {
          vistos.add(g);
          grupos.push(g);
        }
      }
    }
    return grupos;
  }

  function quitarGrupoDeMateriaEnEstado(clave, grp) {
    if (!estado.materiasSeleccionadas.includes(clave)) {
      return;
    }
    const actuales = estado.gruposSeleccionadosPorMateria[clave];
    if (!Array.isArray(actuales) || actuales.length === 0) {
      const restantes = obtenerGruposDisponiblesDeMateria(clave).filter(
        (g) => g !== grp
      );
      if (restantes.length > 0) {
        estado.gruposSeleccionadosPorMateria[clave] = restantes;
      } else {
        estado.materiasSeleccionadas = estado.materiasSeleccionadas.filter(
          (c) => c !== clave
        );
        delete estado.gruposSeleccionadosPorMateria[clave];
      }
      return;
    }

    const siguientes = actuales.filter((g) => g !== grp);
    if (siguientes.length > 0) {
      estado.gruposSeleccionadosPorMateria[clave] = siguientes;
    } else {
      estado.materiasSeleccionadas = estado.materiasSeleccionadas.filter(
        (c) => c !== clave
      );
      delete estado.gruposSeleccionadosPorMateria[clave];
    }
  }

  function agregarGrupoAMateriaEnEstado(clave, grp) {
    if (!estado.materiasSeleccionadas.includes(clave)) {
      estado.materiasSeleccionadas = [...estado.materiasSeleccionadas, clave];
      estado.gruposSeleccionadosPorMateria[clave] = [grp];
      return;
    }
    const actuales = estado.gruposSeleccionadosPorMateria[clave];
    if (!Array.isArray(actuales) || actuales.length === 0) {
      return;
    }
    if (!actuales.includes(grp)) {
      estado.gruposSeleccionadosPorMateria[clave] = [...actuales, grp];
    }
  }

  function alternarGrupoDeMateria(claveMateria, grupo) {
    const clave = String(claveMateria || "").trim();
    const grp = String(grupo || "").trim();
    if (!clave || !grp) {
      return;
    }
    if (estaGrupoSeleccionadoParaMateria(estado, clave, grp)) {
      quitarGrupoDeMateriaEnEstado(clave, grp);
    } else {
      agregarGrupoAMateriaEnEstado(clave, grp);
    }
    notificar();
  }

  function alternarGrupoCompleto(grupo, clavesGrupo = []) {
    const grp = String(grupo || "").trim();
    const unicas = [];
    const vistas = new Set();
    for (const c of clavesGrupo) {
      const clave = String(c || "").trim();
      if (clave && !vistas.has(clave)) {
        vistas.add(clave);
        unicas.push(clave);
      }
    }
    if (!grp || unicas.length === 0) {
      return { accion: "ninguna", grupo: grp, total: 0 };
    }

    const todasElegidas = unicas.every((c) =>
      estaGrupoSeleccionadoParaMateria(estado, c, grp)
    );
    if (todasElegidas) {
      for (const c of unicas) {
        quitarGrupoDeMateriaEnEstado(c, grp);
      }
    } else {
      for (const c of unicas) {
        agregarGrupoAMateriaEnEstado(c, grp);
      }
    }
    notificar();
    return {
      accion: todasElegidas ? "quitado" : "seleccionado",
      grupo: grp,
      total: unicas.length,
    };
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
    for (const clave of Object.keys(estado.gruposSeleccionadosPorMateria)) {
      if (!vistas.has(clave)) {
        delete estado.gruposSeleccionadosPorMateria[clave];
      }
    }
    notificar();
  }

  function limpiarMateriasSeleccionadas() {
    estado.materiasSeleccionadas = [];
    estado.gruposSeleccionadosPorMateria = {};
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

    const mapaGruposElegidos = estado.gruposSeleccionadosPorMateria || {};
    const entradaMotor = estado.materiasSeleccionadas.map((clave) => {
      const encontrado = mapaAgrupado.get(clave);
      const gruposEspecificos = mapaGruposElegidos[clave];
      const setGrupos =
        Array.isArray(gruposEspecificos) && gruposEspecificos.length > 0
          ? new Set(gruposEspecificos.map((g) => String(g || "").trim()))
          : null;
      const opciones = encontrado
        ? setGrupos
          ? encontrado.grupos.filter((r) =>
              setGrupos.has(String(r.grupo || "").trim())
            )
          : encontrado.grupos
        : [];
      return {
        clave,
        materia:
          encontrado?.materia || mapaNombresGlobal.get(clave) || clave,
        opciones,
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
    const evaluacion = calcularPuntaje(
      metricas,
      estado.preferencias.pesos,
      estado.preferencias
    );
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
    alternarGrupoDeMateria,
    alternarGrupoCompleto,
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
  if (filtros.soloPresenciales) {
    total += 1;
  }
  if (
    filtros.soloConCupo ||
    (filtros.cupoMinimo !== null &&
      filtros.cupoMinimo !== undefined &&
      Number(filtros.cupoMinimo) > 0)
  ) {
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
  let ultimasSeleccionadas = new Set();
  let ultimaFirmaRecs = "";
  let ultimaFirmaGrilla = "";
  let ultimoGrupoExpandido = "";
  let ultimaMateriaExpandida = "";
  let ultimoInspectorRegistroId = "";
  let timerPulsoBarra = null;
  const seccionesVisibles = new Set(["recomendaciones"]);

  try {
    sidebarColapsado = globalThis.localStorage?.getItem("horarios:sidebarColapsado") === "1";
  } catch {
    sidebarColapsado = false;
  }

  const els = {
    topbar: doc.querySelector(".topbar"),
    topbarProgress: doc.getElementById("topbar-progress"),
    appShell: doc.getElementById("app-shell"),
    badgeSemestreActivo: doc.getElementById("badge-semestre-activo"),
    btnToggleSidebar: doc.getElementById("btn-toggle-sidebar"),
    labelToggleSidebar: doc.getElementById("label-toggle-sidebar"),
    datasetSelect: doc.getElementById("dataset-select"),
    panelInspector: doc.getElementById("panel-inspector"),
    contadorCatalogo: doc.getElementById("contador-catalogo"),
    inspectorTabs: doc.querySelector(".inspector-tabs"),
    tabPanelMaterias: doc.getElementById("tab-panel-materias"),
    tabPanelAjustes: doc.getElementById("tab-panel-ajustes"),
    badgeAjustes: doc.getElementById("badge-ajustes"),
    vistaPanelMaterias: doc.getElementById("vista-panel-materias"),
    vistaPanelAjustes: doc.getElementById("vista-panel-ajustes"),
    badgeSubCupo: doc.getElementById("badge-sub-cupo"),
    badgeSubExclusiones: doc.getElementById("badge-sub-exclusiones"),
    badgeSubSolapamiento: doc.getElementById("badge-sub-solapamiento"),
    badgeSubPesos: doc.getElementById("badge-sub-pesos"),
    catalogModeSwitch: doc.querySelector(".catalog-mode-switch"),
    btnAgruparGrupo: doc.getElementById("btn-agrupar-grupo"),
    btnAgruparMateria: doc.getElementById("btn-agrupar-materia"),
    filtroTexto: doc.getElementById("filtro-texto"),
    btnLimpiarTexto: doc.getElementById("btn-limpiar-texto"),
    filtroSemestreGrupo: doc.getElementById("filtro-semestre-grupo"),
    filtroDias: doc.getElementById("filtro-dias"),
    filtroHoraMin: doc.getElementById("filtro-hora-min"),
    filtroHoraMax: doc.getElementById("filtro-hora-max"),
    filtroCupoMin: doc.getElementById("filtro-cupo-min"),
    chipsCupoMin: doc.getElementById("chips-cupo-min"),
    inputExcluirProf: doc.getElementById("input-excluir-profesor"),
    btnExcluirProf: doc.getElementById("btn-excluir-profesor"),
    datalistProfesores: doc.getElementById("datalist-profesores"),
    listaProfExcluidos: doc.getElementById("lista-profesores-excluidos"),
    inputExcluirGrupo: doc.getElementById("input-excluir-grupo"),
    btnExcluirGrupo: doc.getElementById("btn-excluir-grupo"),
    datalistGrupos: doc.getElementById("datalist-grupos"),
    listaGruposExcluidos: doc.getElementById("lista-grupos-excluidos"),
    presetPreferencias: doc.getElementById("preset-preferencias"),
    prefModalidadSelector: doc.getElementById("pref-modalidad-selector"),
    descModalidadActiva: doc.getElementById("desc-modalidad-activa"),
    pesoDiasLibres: doc.getElementById("peso-dias-libres"),
    valPesoDiasLibres: doc.getElementById("val-peso-dias-libres"),
    pesoHuecos: doc.getElementById("peso-huecos"),
    valPesoHuecos: doc.getElementById("val-peso-huecos"),
    pesoRango: doc.getElementById("peso-rango"),
    valPesoRango: doc.getElementById("val-peso-rango"),
    pesoConcentracion: doc.getElementById("peso-concentracion"),
    valPesoConcentracion: doc.getElementById("val-peso-concentracion"),
    prefPermitirSolap: doc.getElementById("pref-permitir-solapamiento"),
    controlesTolerancia: doc.getElementById("controles-tolerancia"),
    prefToleranciaMin: doc.getElementById("pref-tolerancia-min"),
    chipsTolerancia: doc.getElementById("chips-tolerancia"),
    prefMaxCombinaciones: doc.getElementById("pref-max-combinaciones"),
    btnLimpiarFiltros: doc.getElementById("btn-limpiar-filtros"),
    catalogoMaterias: doc.getElementById("catalogo-materias"),
    barraSeleccionadas: doc.getElementById("barra-seleccionadas"),
    contadorSeleccionadas: doc.getElementById("contador-seleccionadas"),
    listaSeleccionadas: doc.getElementById("lista-seleccionadas"),
    btnLimpiarSeleccion: doc.getElementById("btn-limpiar-seleccion"),
    seccionRecomendaciones: doc.getElementById("seccion-recomendaciones"),
    statusDotRecs: doc.getElementById("status-dot-recs"),
    telemetryRecomendaciones: doc.getElementById("telemetry-recomendaciones"),
    panelDiagnostico: doc.getElementById("panel-diagnostico"),
    gridRecomendaciones: doc.getElementById("grid-recomendaciones"),
    recsFooter: doc.getElementById("recs-footer"),
    btnVerMasRecs: doc.getElementById("btn-ver-mas-recs"),
    seccionGrilla: doc.getElementById("seccion-grilla"),
    tabModoRecomendado: doc.getElementById("tab-modo-recomendado"),
    tabModoManual: doc.getElementById("tab-modo-manual"),
    navLinks: Array.from(doc.querySelectorAll(".topbar-nav [data-nav-target]")),
    studioTitulo: doc.getElementById("studio-titulo"),
    studioKpis: doc.getElementById("studio-kpis"),
    menuExportar: doc.getElementById("menu-exportar"),
    btnExportarPdf: doc.getElementById("btn-exportar-pdf"),
    btnExportarPng: doc.getElementById("btn-exportar-png"),
    bannerAdvertencias: doc.getElementById("banner-advertencias"),
    panelManual: doc.getElementById("panel-manual"),
    grillaSemanal: doc.getElementById("grilla-semanal"),
    inspectorBloque: doc.getElementById("inspector-bloque"),
    leyendaImpresion: doc.getElementById("leyenda-impresion"),
    footerDatasetInfo: doc.getElementById("footer-dataset-info"),
    toastRegion: doc.getElementById("toast-region"),
  };

  const mostrarToast = (mensaje, tipo = "info") => {
    if (!els.toastRegion || !mensaje) return;
    while (els.toastRegion.children.length >= 3) {
      els.toastRegion.firstElementChild?.remove();
    }
    const toast = doc.createElement("div");
    toast.className = `toast-item is-${tipo}`;
    toast.textContent = mensaje;
    els.toastRegion.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 220);
    }, 2400);
  };

  const pulsarBarraProgreso = () => {
    if (!els.topbarProgress) return;
    clearTimeout(timerPulsoBarra);
    els.topbarProgress.classList.remove("is-pulsing");
    void els.topbarProgress.offsetWidth;
    els.topbarProgress.classList.add("is-pulsing");
    timerPulsoBarra = setTimeout(() => {
      els.topbarProgress?.classList.remove("is-pulsing");
    }, 500);
  };

  const actualizarNavActivo = () => {
    if (!els.navLinks || els.navLinks.length === 0) return;
    let objetivo = "recomendaciones";
    if (
      modoVista === "manual" ||
      (seccionesVisibles.has("grilla") && !seccionesVisibles.has("recomendaciones"))
    ) {
      objetivo = "grilla";
    }
    for (const link of els.navLinks) {
      link.classList.toggle("is-active", link.dataset.navTarget === objetivo);
    }
  };

  const reanimarClase = (el, clase) => {
    if (!el?.classList) return;
    el.classList.remove(clase);
    void el.offsetWidth;
    el.classList.add(clase);
  };

  poblarSelectHoras(els.filtroHoraMin, true, "Sin mín.");
  poblarSelectHoras(els.filtroHoraMax, true, "Sin máx.");

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

  const DESCRIPCIONES_MODALIDAD = {
    indistinto: "Incluye grupos presenciales, híbridos y en línea sin preferencia.",
    preferirEnLinea:
      "Prioriza combinaciones con materias a distancia o híbridas sin excluir presenciales.",
    soloPresenciales: "Muestra y combina únicamente grupos 100% presenciales.",
  };

  const sincronizarControlesPreferencias = (
    estado,
    materiasConEnLineaCarrera = 0,
    materiasSelConEnLinea = 0
  ) => {
    const p = estado.preferencias;
    if (els.presetPreferencias) {
      for (const btn of els.presetPreferencias.querySelectorAll("[data-preset]")) {
        btn.classList.toggle("is-active", btn.dataset.preset === p.preset);
      }
    }
    const totalSel = estado.materiasSeleccionadas?.length || 0;
    const puedeConfigurarModalidad =
      materiasConEnLineaCarrera > 0 && materiasSelConEnLinea > 0;
    const modActiva = puedeConfigurarModalidad
      ? p.preferenciaModalidad || "indistinto"
      : "indistinto";

    if (els.prefModalidadSelector) {
      for (const btn of els.prefModalidadSelector.querySelectorAll("[data-modalidad]")) {
        const modoBtn = btn.dataset.modalidad;
        const deshabilitado = !puedeConfigurarModalidad && modoBtn !== "indistinto";
        const activo = modoBtn === modActiva;
        btn.disabled = deshabilitado;
        btn.classList.toggle("is-active", activo);
        btn.setAttribute("aria-pressed", String(activo));
      }
    }
    if (els.descModalidadActiva) {
      let texto = DESCRIPCIONES_MODALIDAD.indistinto;
      let claseEstado = "";

      if (materiasConEnLineaCarrera === 0) {
        texto =
          "Esta carrera es 100% presencial en este semestre (no hay materias en línea).";
        claseEstado = "is-info";
      } else if (totalSel === 0) {
        texto = `Esta carrera tiene ${materiasConEnLineaCarrera} ${
          materiasConEnLineaCarrera === 1 ? "materia" : "materias"
        } con opción en línea. Selecciona alguna para activar este ajuste.`;
        claseEstado = "is-info";
      } else if (materiasSelConEnLinea === 0) {
        texto =
          "Ninguna de tus materias elegidas tiene opción en línea o híbrida.";
        claseEstado = "is-warn";
      } else if (modActiva === "preferirEnLinea") {
        texto = `Priorizando materias en línea/híbridas (${materiasSelConEnLinea} disponibles) sin afectar concentración ni días libres.`;
        claseEstado = "is-info";
      } else if (modActiva === "soloPresenciales") {
        texto =
          "Excluyendo grupos en línea/híbridos en tus materias elegidas (solo presenciales).";
      } else {
        texto = `${materiasSelConEnLinea} de tus materias tienen opción en línea/híbrida. Las materias en línea no penalizan días ni concentración.`;
      }

      els.descModalidadActiva.textContent = texto;
      els.descModalidadActiva.classList.toggle("is-warn", claseEstado === "is-warn");
      els.descModalidadActiva.classList.toggle("is-info", claseEstado === "is-info");
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
    if (els.pesoConcentracion) {
      els.pesoConcentracion.value = String(p.pesos.concentracionDiaria);
      if (els.valPesoConcentracion) {
        els.valPesoConcentracion.textContent = String(p.pesos.concentracionDiaria);
      }
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
    const cupoMinActual =
      estado.filtros.cupoMinimo !== null &&
      estado.filtros.cupoMinimo !== undefined &&
      Number(estado.filtros.cupoMinimo) > 0
        ? Number(estado.filtros.cupoMinimo)
        : estado.filtros.soloConCupo
        ? 1
        : 0;
    const exclusionesCount =
      (estado.filtros.profesoresExcluidos?.length || 0) +
      (estado.filtros.gruposExcluidos?.length || 0);
    const solapActivo = Boolean(estado.preferencias.permitirSolapamiento);
    const presetAlterado = estado.preferencias.preset !== "balanceado";
    const pesosCustom = estado.preferencias.preset === "personalizado";
    const modPreferirEnLinea =
      estado.preferencias.preferenciaModalidad === "preferirEnLinea";

    if (els.badgeSubCupo) {
      els.badgeSubCupo.hidden = cupoMinActual <= 0;
      els.badgeSubCupo.textContent = `≥ ${cupoMinActual}`;
    }
    if (els.badgeSubExclusiones) {
      els.badgeSubExclusiones.hidden = exclusionesCount === 0;
      els.badgeSubExclusiones.textContent = String(exclusionesCount);
    }
    if (els.badgeSubSolapamiento) {
      els.badgeSubSolapamiento.hidden = !solapActivo;
      els.badgeSubSolapamiento.textContent =
        estado.preferencias.toleranciaSolapamientoMin === null
          ? "∞"
          : `${estado.preferencias.toleranciaSolapamientoMin}m`;
    }
    if (els.badgeSubPesos) {
      els.badgeSubPesos.hidden = !pesosCustom;
    }

    const totalAjustesActivos =
      totalFiltrosActivos +
      (solapActivo ? 1 : 0) +
      (presetAlterado ? 1 : 0) +
      (modPreferirEnLinea ? 1 : 0);
    if (els.badgeAjustes) {
      els.badgeAjustes.hidden = totalAjustesActivos === 0;
      els.badgeAjustes.textContent = String(totalAjustesActivos);
    }
    if (els.btnLimpiarFiltros) {
      els.btnLimpiarFiltros.hidden = totalFiltrosActivos === 0;
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
    if (els.filtroCupoMin) {
      els.filtroCupoMin.value = cupoMinActual > 0 ? String(cupoMinActual) : "";
    }
    if (els.chipsCupoMin) {
      const claveChip = String(cupoMinActual);
      for (const btn of els.chipsCupoMin.querySelectorAll("[data-cupo-min]")) {
        btn.classList.toggle("is-active", btn.dataset.cupoMin === claveChip);
      }
    }

    renderizarCatalogoFiltros(
      {
        tiposClaseEl: null,
        datalistProfesoresEl: els.datalistProfesores,
        datalistGruposEl: els.datalistGrupos,
        profesoresExcluidosEl: els.listaProfExcluidos,
        gruposExcluidosEl: els.listaGruposExcluidos,
      },
      catalogos,
      estado.filtros
    );

    const clavesConEnLineaCarrera = new Set();
    const clavesSelConEnLineaSet = new Set();
    for (const r of estado.horarios) {
      if (r.clv_materia && obtenerPesoEnLineaRegistro(r) > 0) {
        clavesConEnLineaCarrera.add(r.clv_materia);
        if (estaGrupoSeleccionadoParaMateria(estado, r.clv_materia, r.grupo)) {
          clavesSelConEnLineaSet.add(r.clv_materia);
        }
      }
    }
    const seleccionadasLista = estado.materiasSeleccionadas || [];
    const materiasSelConEnLinea = seleccionadasLista.filter((clv) =>
      clavesSelConEnLineaSet.has(clv)
    ).length;
    const puedeConfigurarModalidad =
      clavesConEnLineaCarrera.size > 0 && materiasSelConEnLinea > 0;

    if (
      !puedeConfigurarModalidad &&
      (estado.preferencias.preferenciaModalidad !== "indistinto" ||
        estado.filtros.soloPresenciales)
    ) {
      if (estado.preferencias.preferenciaModalidad !== "indistinto") {
        ctrl.actualizarPreferencias({ preferenciaModalidad: "indistinto" });
      }
      if (estado.filtros.soloPresenciales) {
        ctrl.actualizarFiltros({ soloPresenciales: false });
      }
      return;
    }

    sincronizarControlesPreferencias(
      estado,
      clavesConEnLineaCarrera.size,
      materiasSelConEnLinea
    );

    const esPorGrupo = modoCatalogo === "grupo";
    if (els.catalogModeSwitch?.style) {
      els.catalogModeSwitch.style.setProperty("--tab-index", esPorGrupo ? "0" : "1");
    }
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
        Boolean(estado.filtros.texto),
        ultimoGrupoExpandido
      );
    } else {
      renderizarCatalogoMaterias(
        els.catalogoMaterias,
        materiasAgrupadas,
        estado,
        materiasExpandidas,
        ultimaMateriaExpandida
      );
    }
    ultimoGrupoExpandido = "";
    ultimaMateriaExpandida = "";

    const horarioActivo = obtenerHorarioActivo(estado);
    const clavesColor = [
      ...estado.materiasSeleccionadas,
      ...(horarioActivo?.registros || []).map((r) => r.clv_materia),
    ];
    const mapaColoresGlobal = construirMapaColoresMaterias(clavesColor);

    const seleccionadasActual = estado.materiasSeleccionadas || [];
    const clavesNuevas = new Set(
      seleccionadasActual.filter((c) => !ultimasSeleccionadas.has(c))
    );
    const cambioCantidad = seleccionadasActual.length !== ultimasSeleccionadas.size;
    ultimasSeleccionadas = new Set(seleccionadasActual);

    renderizarMateriasSeleccionadas(
      els.listaSeleccionadas,
      els.contadorSeleccionadas,
      estado,
      mapaNombres,
      clavesNuevas,
      mapaColoresGlobal
    );

    if (cambioCantidad) {
      reanimarClase(els.contadorSeleccionadas, "is-bumped");
    }

    const totalSel = seleccionadasActual.length;
    if (els.barraSeleccionadas) {
      els.barraSeleccionadas.classList.toggle("is-empty", totalSel === 0);
    }
    if (els.btnLimpiarSeleccion) {
      els.btnLimpiarSeleccion.hidden = totalSel === 0;
    }

    if (els.statusDotRecs) {
      const tieneRecs = (estado.resultadoRecomendaciones?.recomendaciones || []).length > 0;
      const tieneDiag = Boolean(estado.resultadoRecomendaciones?.diagnostico);
      els.statusDotRecs.classList.toggle("is-ready", tieneRecs);
      els.statusDotRecs.classList.toggle("is-warn", !tieneRecs && tieneDiag);
    }

    renderizarDiagnostico(
      els.panelDiagnostico,
      estado.resultadoRecomendaciones?.diagnostico || null
    );

    const recsLista = estado.resultadoRecomendaciones?.recomendaciones || [];
    const firmaRecs = estado.resultadoRecomendaciones
      ? `${recsLista.length}:${recsLista
          .slice(0, limiteVisibleRecs)
          .map((r) => `${r.id}@${r.puntaje}`)
          .join(",")}`
      : "none";
    const animarEntradaRecs =
      firmaRecs !== ultimaFirmaRecs && Boolean(estado.resultadoRecomendaciones);
    ultimaFirmaRecs = firmaRecs;

    renderizarRecomendaciones(
      els.gridRecomendaciones,
      els.recsFooter,
      els.telemetryRecomendaciones,
      estado.resultadoRecomendaciones,
      estado.recomendacionActivaId,
      limiteVisibleRecs,
      {
        mapaColores: mapaColoresGlobal,
        animarEntrada: animarEntradaRecs,
        mostrarBadgeLimpio: Boolean(estado.preferencias.permitirSolapamiento),
      }
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
        const manualIds = new Set(
          (estado.seleccionManual || []).map(
            (r) => r.id || `${r.clv_materia}:${r.grupo}`
          )
        );
        const filtradosManual = filtrarHorarios(estado.horarios, {
          ...estado.filtros,
          texto: "",
          semestresGrupo: [],
        }).filter((r) => {
          const id = r.id || `${r.clv_materia}:${r.grupo}`;
          return (
            manualIds.has(id) ||
            estaGrupoSeleccionadoParaMateria(estado, r.clv_materia, r.grupo)
          );
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

    const firmaGrilla = `${modoVista}:${
      horarioActivo
        ? horarioActivo.id ||
          (horarioActivo.registros || [])
            .map((r) => r.id || `${r.clv_materia}:${r.grupo}`)
            .join(",")
        : "empty"
    }`;
    const animarBloques =
      firmaGrilla !== ultimaFirmaGrilla && (horarioActivo?.registros?.length || 0) > 0;
    ultimaFirmaGrilla = firmaGrilla;

    renderizarGrillaSemanal(
      {
        grillaEl: els.grillaSemanal,
        tituloEl: els.studioTitulo,
        kpisEl: els.studioKpis,
        bannerAdvertenciasEl: els.bannerAdvertencias,
        leyendaImpresionEl: els.leyendaImpresion,
      },
      horarioActivo,
      bloqueInspectorId,
      {
        mapaColores: mapaColoresGlobal,
        animarBloques,
      }
    );

    const regInspectado =
      horarioActivo?.registros?.find(
        (r) => (r.id || `${r.clv_materia}:${r.grupo}`) === registroInspectorId
      ) || null;
    const colorInspector = regInspectado
      ? asignarColorMateria(regInspectado.clv_materia, mapaColoresGlobal)
      : "";
    renderizarInspectorBloque(els.inspectorBloque, regInspectado, colorInspector);
    if (regInspectado && registroInspectorId !== ultimoInspectorRegistroId) {
      reanimarClase(els.inspectorBloque, "is-entering");
    }
    ultimoInspectorRegistroId = regInspectado ? registroInspectorId : "";
    actualizarNavActivo();

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
    const tieneOpcionEnLinea = estado.horarios.some(
      (r) =>
        estaGrupoSeleccionadoParaMateria(estado, r.clv_materia, r.grupo) &&
        obtenerPesoEnLineaRegistro(r) > 0
    );
    if (!tieneOpcionEnLinea) {
      if (estado.preferencias.preferenciaModalidad !== "indistinto") {
        ctrl.actualizarPreferencias({ preferenciaModalidad: "indistinto" });
      }
      if (estado.filtros.soloPresenciales) {
        ctrl.actualizarFiltros({ soloPresenciales: false });
      }
    }
    pulsarBarraProgreso();
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
    ultimoInspectorRegistroId = "";
    ultimaFirmaRecs = "";
    ultimaFirmaGrilla = "";
    ultimasSeleccionadas = new Set();
    materiasExpandidas.clear();
    gruposExpandidos.clear();
    try {
      globalThis.localStorage?.setItem("horarios:carrera", archivo);
    } catch {
      // Ignora si el almacenamiento local no está disponible
    }
    els.topbarProgress?.classList.add("is-loading");
    renderizarSkeletonCatalogo(els.catalogoMaterias);
    try {
      const estadoNuevo = await ctrl.cargarDatos(`${baseDataUrl}/${archivo}`);
      const tieneNoPresenciales = estadoNuevo.horarios.some(
        (r) => obtenerPesoEnLineaRegistro(r) > 0
      );
      if (!tieneNoPresenciales) {
        if (estadoNuevo.preferencias.preferenciaModalidad !== "indistinto") {
          ctrl.actualizarPreferencias({ preferenciaModalidad: "indistinto" });
        }
        ctrl.actualizarFiltros({ semestresGrupo: [], soloPresenciales: false });
      } else {
        ctrl.actualizarFiltros({ semestresGrupo: [] });
      }
      const nombreCarr =
        estadoNuevo.metadata?.nombre_carrera ||
        datasetsDisponibles.find((d) => d.archivo === archivo)?.nombre_carrera ||
        archivo;
      mostrarToast(`Catálogo cargado: ${nombreCarr}`, "success");
    } finally {
      els.topbarProgress?.classList.remove("is-loading");
    }
  });

  // Eventos: pestañas del configurador (01 MATERIAS / 02 AJUSTES)
  const cambiarTabPanel = (tab) => {
    tabPanelActivo = tab;
    const indices = { materias: "0", ajustes: "1" };
    if (els.inspectorTabs?.style) {
      els.inspectorTabs.style.setProperty("--tab-index", indices[tab] ?? "0");
    }
    const mapa = [
      ["materias", els.tabPanelMaterias, els.vistaPanelMaterias],
      ["ajustes", els.tabPanelAjustes, els.vistaPanelAjustes],
    ];
    for (const [clave, btn, panel] of mapa) {
      const activo = clave === tab;
      btn?.classList.toggle("is-active", activo);
      btn?.setAttribute("aria-selected", String(activo));
      if (panel) {
        panel.hidden = !activo;
        if (activo) {
          reanimarClase(panel, "is-entering");
        }
      }
    }
  };
  for (const btn of [els.tabPanelMaterias, els.tabPanelAjustes]) {
    btn?.addEventListener("click", () => {
      if (btn.dataset.panelTab) cambiarTabPanel(btn.dataset.panelTab);
    });
  }

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

  // Eventos: rango horario y cupo mínimo
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

  els.filtroCupoMin?.addEventListener("input", (e) => {
    const raw = e.target.value.trim();
    const num = raw === "" ? 0 : Math.floor(Number(raw));
    ctrl.actualizarFiltros({
      soloConCupo: false,
      cupoMinimo: Number.isFinite(num) && num > 0 ? num : null,
    });
    recalcularRecomendaciones();
  });

  els.chipsCupoMin?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cupo-min]");
    if (!btn) return;
    const min = Number(btn.dataset.cupoMin) || 0;
    ctrl.actualizarFiltros({
      soloConCupo: false,
      cupoMinimo: min > 0 ? min : null,
    });
    recalcularRecomendaciones();
  });

  // Eventos: exclusiones
  const agregarExclusionProfesor = () => {
    const nombre = els.inputExcluirProf?.value.trim();
    if (!nombre) return;
    ctrl.excluirProfesor(nombre);
    els.inputExcluirProf.value = "";
    recalcularRecomendaciones();
    mostrarToast(`Docente excluido: ${nombre}`);
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
    mostrarToast(`Grupo excluido: ${grupo}`);
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

  // Eventos: preferencias, modalidad, pesos y tolerancia de solapamiento
  els.presetPreferencias?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    ctrl.aplicarPresetPreferencias(btn.dataset.preset);
    recalcularRecomendaciones();
  });

  els.prefModalidadSelector?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-modalidad]");
    if (!btn || btn.disabled) return;
    const modo = btn.dataset.modalidad;
    ctrl.actualizarPreferencias({ preferenciaModalidad: modo });
    ctrl.actualizarFiltros({ soloPresenciales: modo === "soloPresenciales" });
    recalcularRecomendaciones();
    const etiquetasToast = {
      indistinto: "Modalidad: Indistinto",
      preferirEnLinea: "Modalidad: Preferir en línea",
      soloPresenciales: "Modalidad: Solo presenciales",
    };
    mostrarToast(etiquetasToast[modo] || "Modalidad actualizada");
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
  enlazarSliderPeso(els.pesoConcentracion, "concentracionDiaria");

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
    if (ctrl.obtenerEstado().preferencias.preferenciaModalidad === "soloPresenciales") {
      ctrl.actualizarPreferencias({ preferenciaModalidad: "indistinto" });
    }
    recalcularRecomendaciones();
    mostrarToast("Filtros restablecidos");
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
        ultimoGrupoExpandido = grp;
      }
      sincronizarVista();
      return;
    }

    const toggleGrupoBtn = e.target.closest("[data-toggle-grupo-completo]");
    if (toggleGrupoBtn) {
      const grupoId = toggleGrupoBtn.dataset.toggleGrupoCompleto;
      const clavesGrupo = String(toggleGrupoBtn.dataset.claves || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      if (clavesGrupo.length === 0) return;

      const resGrupo = ctrl.alternarGrupoCompleto(grupoId, clavesGrupo);
      if (resGrupo.accion === "quitado") {
        mostrarToast(`Grupo ${grupoId} quitado de la selección`);
      } else {
        mostrarToast(`Grupo ${grupoId} seleccionado (${clavesGrupo.length} materias)`, "success");
      }
      recalcularRecomendaciones();
      return;
    }

    const toggleMatGrupoBtn = e.target.closest("[data-toggle-materia-grupo]");
    if (toggleMatGrupoBtn) {
      ctrl.alternarGrupoDeMateria(
        toggleMatGrupoBtn.dataset.toggleMateriaGrupo,
        toggleMatGrupoBtn.dataset.grupo
      );
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
        ultimaMateriaExpandida = clave;
      }
      sincronizarVista();
      return;
    }

    const exclProfBtn = e.target.closest("[data-excluir-profesor]");
    if (exclProfBtn) {
      const prof = exclProfBtn.dataset.excluirProfesor;
      ctrl.excluirProfesor(prof);
      recalcularRecomendaciones();
      mostrarToast(`Docente excluido: ${prof}`);
      return;
    }

    const exclGrpBtn = e.target.closest("[data-excluir-grupo]");
    if (exclGrpBtn) {
      const grp = exclGrpBtn.dataset.excluirGrupo;
      ctrl.excluirGrupo(grp);
      recalcularRecomendaciones();
      mostrarToast(`Grupo excluido: ${grp}`);
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
        if (
          !estaGrupoSeleccionadoParaMateria(
            estado,
            registro.clv_materia,
            registro.grupo
          )
        ) {
          ctrl.alternarGrupoDeMateria(registro.clv_materia, registro.grupo);
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
        els.labelToggleSidebar.textContent = abiertoMovil ? "OCULTAR" : "PANEL";
      }
    } else {
      els.panelInspector?.classList.remove("is-open");
      els.appShell?.classList.toggle("is-sidebar-collapsed", sidebarColapsado);
      els.btnToggleSidebar?.setAttribute("aria-expanded", String(!sidebarColapsado));
      if (els.labelToggleSidebar) {
        els.labelToggleSidebar.textContent = sidebarColapsado ? "PANEL" : "OCULTAR";
      }
    }
  };

  const enfocarBusqueda = () => {
    if (esVistaMovil()) {
      els.panelInspector?.classList.add("is-open");
    } else if (sidebarColapsado) {
      sidebarColapsado = false;
      try {
        globalThis.localStorage?.setItem("horarios:sidebarColapsado", "0");
      } catch {
        // Ignora errores de almacenamiento
      }
    }
    aplicarEstadoSidebar();
    cambiarTabPanel("materias");
    els.filtroTexto?.focus();
  };

  // Eventos: recomendaciones y diagnóstico
  els.gridRecomendaciones?.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="enfocar-busqueda"]')) {
      enfocarBusqueda();
      return;
    }
    const card = e.target.closest("[data-seleccionar-rec]");
    if (!card) return;
    modoVista = "recomendado";
    bloqueInspectorId = "";
    registroInspectorId = "";
    ctrl.seleccionarRecomendacion(card.dataset.seleccionarRec);
    const idxEl = card.querySelector(".rec-index");
    if (idxEl?.textContent) {
      mostrarToast(`Vista actualizada: Opción #${idxEl.textContent.trim()}`);
    }
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
      mostrarToast(`Tolerancia de solapamiento: ${minutos} min`, "warning");
      return;
    }

    if (e.target.closest('[data-action="limpiar-filtros-diag"]')) {
      ctrl.limpiarFiltros();
      if (ctrl.obtenerEstado().preferencias.preferenciaModalidad === "soloPresenciales") {
        ctrl.actualizarPreferencias({ preferenciaModalidad: "indistinto" });
      }
      recalcularRecomendaciones();
      mostrarToast("Filtros restablecidos");
    }
  });

  // Eventos: tabs de estudio y comparador manual
  els.tabModoRecomendado?.addEventListener("click", () =>
    cambiarModoVista("recomendado")
  );
  els.tabModoManual?.addEventListener("click", () => cambiarModoVista("manual"));

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

  // Eventos: inspector de bloques y resaltado cruzado en la grilla
  els.grillaSemanal?.addEventListener("click", (e) => {
    const bloqueBtn = e.target.closest("[data-inspeccionar-bloque]");
    if (!bloqueBtn) return;
    bloqueInspectorId = bloqueBtn.dataset.inspeccionarBloque || "";
    registroInspectorId = bloqueBtn.dataset.registroId || "";
    sincronizarVista();
  });

  const limpiarHoverMateria = () => {
    if (!els.grillaSemanal) return;
    els.grillaSemanal.classList.remove("has-subject-hover");
    for (const el of els.grillaSemanal.querySelectorAll(".class-block.is-same-subject")) {
      el.classList.remove("is-same-subject");
    }
  };

  els.grillaSemanal?.addEventListener("pointerover", (e) => {
    const bloqueBtn = e.target.closest(".class-block");
    if (!bloqueBtn || !els.grillaSemanal) return;
    const clv = bloqueBtn.dataset.clvMateria;
    if (!clv) return;
    limpiarHoverMateria();
    els.grillaSemanal.classList.add("has-subject-hover");
    for (const el of els.grillaSemanal.querySelectorAll(".class-block")) {
      if (el.dataset.clvMateria === clv) {
        el.classList.add("is-same-subject");
      }
    }
  });

  els.grillaSemanal?.addEventListener("pointerout", (e) => {
    const bloqueBtn = e.target.closest(".class-block");
    if (!bloqueBtn) return;
    const related = e.relatedTarget?.closest?.(".class-block");
    if (related && related.dataset.clvMateria === bloqueBtn.dataset.clvMateria) {
      return;
    }
    if (!related) {
      limpiarHoverMateria();
    }
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
      const prof = exclProf.dataset.excluirProfesor;
      ctrl.excluirProfesor(prof);
      bloqueInspectorId = "";
      registroInspectorId = "";
      recalcularRecomendaciones();
      mostrarToast(`Docente excluido: ${prof}`);
      return;
    }

    const exclGrp = e.target.closest("[data-excluir-grupo]");
    if (exclGrp) {
      const grp = exclGrp.dataset.excluirGrupo;
      ctrl.excluirGrupo(grp);
      bloqueInspectorId = "";
      registroInspectorId = "";
      recalcularRecomendaciones();
      mostrarToast(`Grupo excluido: ${grp}`);
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
    if (exportarHorarioPNG(horarioActivo, estado.metadata)) {
      mostrarToast("Horario exportado como PNG", "success");
    } else {
      mostrarToast("Selecciona un horario para exportar", "warning");
    }
  });

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

  // Cierre automático de submenús popover al hacer clic fuera o elegir una acción
  doc.addEventListener("click", (e) => {
    const menusAbiertos = doc.querySelectorAll(
      "details.row-actions-menu[open], details.dropdown-menu[open]"
    );
    for (const menu of menusAbiertos) {
      const clickDentro = menu.contains(e.target);
      const clickEnAccion = Boolean(e.target.closest?.("button"));
      if (!clickDentro || clickEnAccion) {
        menu.open = false;
      }
    }
  });

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("resize", aplicarEstadoSidebar);
    const actualizarScrollTopbar = () => {
      if (els.topbar) {
        els.topbar.classList.toggle("is-scrolled", (globalThis.scrollY || 0) > 8);
      }
    };
    globalThis.addEventListener("scroll", actualizarScrollTopbar, { passive: true });
    actualizarScrollTopbar();
  }

  if (typeof globalThis.IntersectionObserver === "function") {
    const observer = new globalThis.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const clave =
            entry.target === els.seccionRecomendaciones ? "recomendaciones" : "grilla";
          if (entry.isIntersecting) {
            seccionesVisibles.add(clave);
          } else {
            seccionesVisibles.delete(clave);
          }
        }
        actualizarNavActivo();
      },
      { threshold: 0.25 }
    );
    if (els.seccionRecomendaciones) observer.observe(els.seccionRecomendaciones);
    if (els.seccionGrilla) observer.observe(els.seccionGrilla);
  }

  // Carga inicial de índice de carreras (último semestre) y selección predeterminada
  els.topbarProgress?.classList.add("is-loading");
  renderizarSkeletonCatalogo(els.catalogoMaterias);
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
  } finally {
    els.topbarProgress?.classList.remove("is-loading");
  }

  return ctrl;
}

if (typeof document !== "undefined" && document.getElementById("app-horarios")) {
  iniciarAplicacionWeb(document);
}
