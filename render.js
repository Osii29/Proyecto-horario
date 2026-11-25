/**
 * Módulo de renderizado DOM, layout de bloques solapados en grilla semanal
 * y exportación visual (impresión/PDF y PNG en alta resolución).
 *
 * No accede a `document` ni `window` al importarse para ser compatible con Node.
 */

import {
  DIAS_SEMANA,
  esBloqueValido,
  formatearEtiquetaSemestre,
  minutosAHora,
  obtenerSemestreDeGrupo,
} from "./scheduler.js";

const PALETA_PISTAS = [
  "#4f7ec8",
  "#5fa87e",
  "#d4945a",
  "#8c7ae6",
  "#4fa8a8",
  "#c96f8f",
  "#b8a356",
  "#969697",
];

const NOMBRES_DIAS = {
  LU: "LUNES",
  MA: "MARTES",
  MI: "MIÉRCOLES",
  JU: "JUEVES",
  VI: "VIERNES",
  SA: "SÁBADO",
};

/**
 * Escapa caracteres especiales para inserción segura en HTML.
 */
export function escapeHtml(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Asigna un color de pista determinista por clave de materia.
 */
export function asignarColorMateria(clvMateria, mapaColores) {
  const clave = String(clvMateria || "SIN_CLAVE");
  if (mapaColores.has(clave)) {
    return mapaColores.get(clave);
  }
  const color = PALETA_PISTAS[mapaColores.size % PALETA_PISTAS.length];
  mapaColores.set(clave, color);
  return color;
}

/**
 * Construye un mapa de colores determinista compartido entre chips, tarjetas, grilla e inspector.
 */
export function construirMapaColoresMaterias(claves = []) {
  const mapa = new Map();
  for (const clave of claves || []) {
    if (clave !== null && clave !== undefined && String(clave).trim() !== "") {
      asignarColorMateria(String(clave).trim(), mapa);
    }
  }
  return mapa;
}

/**
 * Renderiza filas skeleton animadas mientras se descarga el catálogo de una carrera.
 */
export function renderizarSkeletonCatalogo(contenedor, filas = 6) {
  if (!contenedor) {
    return;
  }
  const items = Array.from(
    { length: filas },
    () => `
      <div class="skeleton-row" aria-hidden="true">
        <div class="skeleton-line is-title"></div>
        <div class="skeleton-line is-meta"></div>
      </div>
    `
  ).join("");
  contenedor.innerHTML = `<div class="catalog-skeleton" role="status" aria-label="Cargando catálogo">${items}</div>`;
}

/**
 * Distribuye bloques de un mismo día en carriles laterales cuando existen solapamientos
 * para que ningún bloque quede oculto debajo de otro.
 */
export function calcularCarrilesSolapados(bloquesDia = []) {
  if (!Array.isArray(bloquesDia) || bloquesDia.length === 0) {
    return [];
  }

  const ordenados = [...bloquesDia].sort(
    (a, b) =>
      a.inicio_min - b.inicio_min ||
      b.fin_min - a.fin_min ||
      String(a.registro?.clv_materia || "").localeCompare(
        String(b.registro?.clv_materia || "")
      )
  );

  const grupos = [];
  let grupoActual = [];
  let finMaxGrupo = -1;

  for (const item of ordenados) {
    if (grupoActual.length === 0 || item.inicio_min < finMaxGrupo) {
      grupoActual.push(item);
      finMaxGrupo = Math.max(finMaxGrupo, item.fin_min);
    } else {
      grupos.push(grupoActual);
      grupoActual = [item];
      finMaxGrupo = item.fin_min;
    }
  }
  if (grupoActual.length > 0) {
    grupos.push(grupoActual);
  }

  const resultado = [];
  for (const grupo of grupos) {
    const finPorColumna = [];
    const asignados = [];

    for (const item of grupo) {
      let colIndex = finPorColumna.findIndex((fin) => fin <= item.inicio_min);
      if (colIndex === -1) {
        colIndex = finPorColumna.length;
        finPorColumna.push(item.fin_min);
      } else {
        finPorColumna[colIndex] = item.fin_min;
      }
      asignados.push({ ...item, colIndex });
    }

    const totalCols = Math.max(1, finPorColumna.length);
    for (const item of asignados) {
      resultado.push({
        ...item,
        totalCols,
        enChoque: totalCols > 1,
      });
    }
  }

  return resultado;
}

function formatearHorasCompactas(bloques = []) {
  if (!Array.isArray(bloques) || bloques.length === 0) {
    return "Sin horario asignado";
  }
  return bloques
    .map((b) => `${b.dia} ${b.hora_texto || ""}`.trim())
    .join(" · ");
}

/**
 * Renderiza el selector de carreras del último semestre y actualiza la insignia de semestre.
 */
export function renderizarSelectDatasets(
  selectEl,
  datasets = [],
  archivoActivo = "",
  semestreEl = null,
  semestreActivo = null
) {
  if (semestreEl) {
    const etiqueta =
      semestreActivo?.etiqueta_semestre ||
      datasets[0]?.etiqueta_semestre ||
      semestreActivo?.semestre ||
      "2027-1";
    semestreEl.textContent = etiqueta;
  }

  if (!selectEl) {
    return;
  }
  if (!Array.isArray(datasets) || datasets.length === 0) {
    selectEl.innerHTML = `<option value="">Sin carreras disponibles</option>`;
    return;
  }

  selectEl.innerHTML = datasets
    .map((ds) => {
      const carrera = ds.nombre_carrera || `Carrera ${ds.carrera}`;
      const selected = ds.archivo === archivoActivo ? "selected" : "";
      return `<option value="${escapeHtml(ds.archivo)}" ${selected}>${escapeHtml(
        carrera
      )}</option>`;
    })
    .join("");
}

/**
 * Pobla el menú desplegable de semestres (deducidos del código de grupo) en `01 MATERIAS`.
 */
export function renderizarSelectSemestres(
  selectEl,
  semestresCatalogo = [],
  semestresActivos = []
) {
  if (!selectEl) {
    return;
  }

  const activo =
    Array.isArray(semestresActivos) && semestresActivos.length > 0
      ? String(semestresActivos[0])
      : "";

  const opciones = [`<option value="">Todos los semestres</option>`];
  for (const s of semestresCatalogo || []) {
    const val = String(s.numero);
    const selected = val === activo ? "selected" : "";
    opciones.push(
      `<option value="${escapeHtml(val)}" ${selected}>${escapeHtml(
        `${s.etiqueta} (${s.totalGrupos} grupos)`
      )}</option>`
    );
  }
  selectEl.innerHTML = opciones.join("");
}

/**
 * Actualiza pills de modalidad, datalists de exclusión y chips activos.
 */
export function renderizarCatalogoFiltros(contenedores, catalogos, filtros) {
  const {
    tiposClaseEl,
    datalistProfesoresEl,
    datalistGruposEl,
    profesoresExcluidosEl,
    gruposExcluidosEl,
  } = contenedores;

  if (tiposClaseEl) {
    const activos = new Set((filtros.tiposClase || []).map((t) => t.toUpperCase()));
    tiposClaseEl.innerHTML = (catalogos.tiposClase || [])
      .map((tipo) => {
        const isActive = activos.has(tipo.toUpperCase());
        return `<button type="button" class="pill-btn ${
          isActive ? "is-active" : ""
        }" data-tipo-clase="${escapeHtml(tipo)}" aria-pressed="${isActive}">${escapeHtml(
          tipo
        )}</button>`;
      })
      .join("");
  }

  if (datalistProfesoresEl) {
    datalistProfesoresEl.innerHTML = (catalogos.profesores || [])
      .map((prof) => `<option value="${escapeHtml(prof)}"></option>`)
      .join("");
  }

  if (datalistGruposEl) {
    datalistGruposEl.innerHTML = (catalogos.grupos || [])
      .map((grp) => `<option value="${escapeHtml(grp)}"></option>`)
      .join("");
  }

  if (profesoresExcluidosEl) {
    profesoresExcluidosEl.innerHTML = (filtros.profesoresExcluidos || [])
      .map(
        (prof) =>
          `<span class="chip">${escapeHtml(
            prof
          )}<button type="button" class="chip-remove" data-quitar-profesor="${escapeHtml(
            prof
          )}" aria-label="Quitar exclusión de ${escapeHtml(prof)}">×</button></span>`
      )
      .join("");
  }

  if (gruposExcluidosEl) {
    gruposExcluidosEl.innerHTML = (filtros.gruposExcluidos || [])
      .map(
        (grp) =>
          `<span class="chip">${escapeHtml(
            grp
          )}<button type="button" class="chip-remove" data-quitar-grupo="${escapeHtml(
            grp
          )}" aria-label="Quitar exclusión de grupo ${escapeHtml(grp)}">×</button></span>`
      )
      .join("");
  }
}

/**
 * Renderiza el catálogo izquierdo de materias con jerarquía clara título -> metadato.
 */
export function renderizarCatalogoMaterias(
  contenedor,
  materiasAgrupadas = [],
  estado = {},
  materiasExpandidas = new Set(),
  recienExpandida = ""
) {
  if (!contenedor) {
    return;
  }

  if (materiasAgrupadas.length === 0) {
    contenedor.innerHTML = `<div class="rec-empty-cell">No hay materias que coincidan con los filtros actuales.</div>`;
    return;
  }

  const seleccionadas = new Set(estado.materiasSeleccionadas || []);

  contenedor.innerHTML = materiasAgrupadas
    .map((item) => {
      const estaSeleccionada = seleccionadas.has(item.clave);
      const estaExpandida = materiasExpandidas.has(item.clave);
      const animarLista = estaExpandida && recienExpandida === item.clave;
      const semsMateria = Array.from(
        new Set(
          item.grupos
            .map((g) => obtenerSemestreDeGrupo(g.grupo))
            .filter((n) => n !== null)
        )
      ).sort((a, b) => a - b);
      const semTexto =
        semsMateria.length > 0
          ? semsMateria.map((n) => formatearEtiquetaSemestre(n, true)).join("/")
          : "";

      const gruposHtml = estaExpandida
        ? `<div class="subject-groups-list ${animarLista ? "is-animating" : ""}">
            ${item.grupos
              .map((g) => {
                const cupoTxt =
                  g.cupo !== null && g.cupo !== undefined
                    ? `Cupo ${g.cupo}`
                    : "Cupo N/D";
                const sinCupo = g.cupo === 0;
                return `
                  <div class="group-mini-card">
                    <div class="group-mini-head">
                      <span>GPO ${escapeHtml(g.grupo)}</span>
                      <div class="group-meta-pills">
                        <span class="group-meta-pill">${escapeHtml(
                          g.tipo_clase || "N/D"
                        )}</span>
                        <span class="group-meta-pill">${escapeHtml(
                          g.salon || "S/S"
                        )}</span>
                        <span class="group-meta-pill ${
                          sinCupo ? "is-empty" : ""
                        }">${escapeHtml(cupoTxt)}</span>
                      </div>
                    </div>
                    <div class="group-mini-meta">${escapeHtml(
                      g.profesor || "Sin docente asignado"
                    )}</div>
                    <div class="group-subject-hours">${escapeHtml(
                      formatearHorasCompactas(g.bloques)
                    )}</div>
                    <div class="group-mini-actions">
                      ${
                        g.profesor
                          ? `<button type="button" class="btn-outline btn-xs" data-excluir-profesor="${escapeHtml(
                              g.profesor
                            )}">Excluir prof.</button>`
                          : ""
                      }
                      <button type="button" class="btn-outline btn-xs" data-excluir-grupo="${escapeHtml(
                        `${g.clv_materia}:${g.grupo}`
                      )}">Excluir grupo</button>
                      <button type="button" class="btn-outline btn-xs" data-fijar-manual="${escapeHtml(
                        g.id || `${g.clv_materia}:${g.grupo}`
                      )}">Probar en manual</button>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : "";

      return `
        <article class="subject-item ${estaSeleccionada ? "is-selected" : ""}">
          <div class="subject-row">
            <button
              type="button"
              class="subject-select-btn"
              data-toggle-materia="${escapeHtml(item.clave)}"
              aria-pressed="${estaSeleccionada}"
            >
              <span class="subject-check" aria-hidden="true">${
                estaSeleccionada ? "✓" : ""
              }</span>
              <div class="subject-content">
                <span class="subject-title">${escapeHtml(item.materia)}</span>
                <span class="subject-meta-line">
                  <span>CLAVE ${escapeHtml(item.clave)}</span>
                  ${
                    semTexto
                      ? `<span>·</span><span class="semester-mini-tag">${escapeHtml(
                          semTexto
                        )}</span>`
                      : ""
                  }
                  <span>·</span>
                  <span>${item.totalGrupos} ${
        item.totalGrupos === 1 ? "grupo" : "grupos"
      }</span>
                </span>
              </div>
            </button>
            <button
              type="button"
              class="subject-expand-btn"
              data-expand-materia="${escapeHtml(item.clave)}"
              aria-expanded="${estaExpandida}"
              title="Ver grupos de ${escapeHtml(item.materia)}"
            >
              ${estaExpandida ? "Ocultar ▲" : "Grupos ▼"}
            </button>
          </div>
          ${gruposHtml}
        </article>
      `;
    })
    .join("");
}

/**
 * Renderiza el catálogo izquierdo agrupado por grupo académico, permitiendo
 * expandir sus materias y seleccionar o quitar todo el grupo en un clic.
 */
export function renderizarCatalogoPorGrupo(
  contenedor,
  gruposAgrupados = [],
  estado = {},
  gruposExpandidos = new Set(),
  expandirTodos = false,
  recienExpandido = ""
) {
  if (!contenedor) {
    return;
  }

  if (gruposAgrupados.length === 0) {
    contenedor.innerHTML = `<div class="rec-empty-cell">No hay grupos que coincidan con los filtros actuales.</div>`;
    return;
  }

  const seleccionadas = new Set(estado.materiasSeleccionadas || []);

  contenedor.innerHTML = gruposAgrupados
    .map((item) => {
      const estaExpandido = expandirTodos || gruposExpandidos.has(item.grupo);
      const animarLista = !expandirTodos && estaExpandido && recienExpandido === item.grupo;
      const elegidasCount = item.clavesMaterias.filter((c) =>
        seleccionadas.has(c)
      ).length;
      const todasElegidas =
        item.totalMaterias > 0 && elegidasCount === item.totalMaterias;
      const semNum = obtenerSemestreDeGrupo(item.grupo);
      const semBadge =
        semNum !== null ? formatearEtiquetaSemestre(semNum, true) : "";

      const materiasHtml = estaExpandido
        ? `<div class="group-subjects-list ${animarLista ? "is-animating" : ""}">
            ${item.registros
              .map((r) => {
                const clave = String(r.clv_materia || "").trim();
                const estaSeleccionada = clave && seleccionadas.has(clave);
                const cupoTxt =
                  r.cupo !== null && r.cupo !== undefined
                    ? `Cupo ${r.cupo}`
                    : "Cupo N/D";
                const sinCupo = r.cupo === 0;
                return `
                  <div class="group-subject-card ${
                    estaSeleccionada ? "is-selected" : ""
                  }">
                    <button
                      type="button"
                      class="subject-select-btn group-subject-btn"
                      data-toggle-materia="${escapeHtml(clave)}"
                      aria-pressed="${estaSeleccionada}"
                    >
                      <span class="subject-check" aria-hidden="true">${
                        estaSeleccionada ? "✓" : ""
                      }</span>
                      <div class="subject-content">
                        <span class="subject-title">${escapeHtml(
                          r.materia || clave
                        )}</span>
                        <div class="group-meta-pills">
                          <span class="group-meta-pill">CLV ${escapeHtml(clave)}</span>
                          <span class="group-meta-pill">${escapeHtml(
                            r.salon || "S/S"
                          )}</span>
                          <span class="group-meta-pill ${
                            sinCupo ? "is-empty" : ""
                          }">${escapeHtml(cupoTxt)}</span>
                        </div>
                        <span class="group-subject-prof">${escapeHtml(
                          r.profesor || "Sin docente asignado"
                        )}</span>
                        <span class="group-subject-hours">${escapeHtml(
                          formatearHorasCompactas(r.bloques)
                        )}</span>
                      </div>
                    </button>
                    <div class="group-subject-actions">
                      ${
                        r.profesor
                          ? `<button type="button" class="btn-outline btn-xs" data-excluir-profesor="${escapeHtml(
                              r.profesor
                            )}">Excluir prof.</button>`
                          : ""
                      }
                      <button type="button" class="btn-outline btn-xs" data-excluir-grupo="${escapeHtml(
                        `${clave}:${r.grupo}`
                      )}">Excluir grupo</button>
                      <button type="button" class="btn-outline btn-xs" data-fijar-manual="${escapeHtml(
                        r.id || `${clave}:${r.grupo}`
                      )}">Probar en manual</button>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>`
        : "";

      return `
        <article class="group-accordion-item ${
          todasElegidas
            ? "is-all-selected"
            : elegidasCount > 0
            ? "has-selected"
            : ""
        }">
          <div class="group-accordion-head">
            <button
              type="button"
              class="group-expand-btn"
              data-expand-grupo="${escapeHtml(item.grupo)}"
              aria-expanded="${estaExpandido}"
            >
              <span class="group-expand-arrow" aria-hidden="true">▸</span>
              <div class="group-head-text">
                <span class="group-head-title">Grupo ${escapeHtml(item.grupo)}</span>
                <span class="group-head-meta">
                  ${
                    semBadge
                      ? `<span class="semester-mini-tag">${escapeHtml(semBadge)}</span> · `
                      : ""
                  }${item.totalMaterias} ${
        item.totalMaterias === 1 ? "materia" : "materias"
      }${
        elegidasCount > 0
          ? ` · ${elegidasCount}/${item.totalMaterias} elegidas`
          : ""
      }
                </span>
              </div>
            </button>
            <button
              type="button"
              class="group-select-all-btn ${todasElegidas ? "is-all-selected" : ""}"
              data-toggle-grupo-completo="${escapeHtml(item.grupo)}"
              data-claves="${escapeHtml(item.clavesMaterias.join(","))}"
              aria-pressed="${todasElegidas}"
              title="${
                todasElegidas
                  ? "Quitar todas las materias de este grupo"
                  : "Elegir todas las materias de este grupo"
              }"
            >
              ${todasElegidas ? "✓ Quitar grupo" : "+ Elegir todas"}
            </button>
          </div>
          ${materiasHtml}
        </article>
      `;
    })
    .join("");
}

/**
 * Renderiza los chips de materias seleccionadas en la barra superior del estudio.
 */
export function renderizarMateriasSeleccionadas(
  contenedor,
  contadorEl,
  estado,
  mapaNombres,
  clavesNuevas = new Set(),
  mapaColoresExt = null
) {
  const seleccionadas = estado.materiasSeleccionadas || [];

  if (contadorEl) {
    contadorEl.textContent = `${seleccionadas.length} ${
      seleccionadas.length === 1 ? "SELECCIONADA" : "SELECCIONADAS"
    }`;
  }

  if (!contenedor) {
    return;
  }

  if (seleccionadas.length === 0) {
    contenedor.innerHTML = `<span class="empty-inline">Elige tus materias desde el panel izquierdo para calcular horarios.</span>`;
    return;
  }

  const mapaColores = mapaColoresExt || construirMapaColoresMaterias(seleccionadas);

  contenedor.innerHTML = seleccionadas
    .map((clave) => {
      const nombre = mapaNombres.get(clave) || clave;
      const color = asignarColorMateria(clave, mapaColores);
      const isNew = clavesNuevas instanceof Set && clavesNuevas.has(clave);
      return `
        <span class="chip ${isNew ? "is-new" : ""}">
          <span class="chip-color-dot" style="--chip-color:${escapeHtml(
            color
          )}" aria-hidden="true"></span>
          <span>${escapeHtml(clave)} · ${escapeHtml(nombre)}</span>
          <button
            type="button"
            class="chip-remove"
            data-quitar-materia="${escapeHtml(clave)}"
            aria-label="Quitar ${escapeHtml(nombre)}"
          >
            ×
          </button>
        </span>
      `;
    })
    .join("");
}

/**
 * Renderiza el diagnóstico de conflictos cuando no hay combinaciones válidas (RF-REC-05).
 */
export function renderizarDiagnostico(contenedor, diagnostico) {
  if (!contenedor) {
    return;
  }

  if (!diagnostico) {
    contenedor.hidden = true;
    contenedor.innerHTML = "";
    return;
  }

  const maxSolap =
    Number.isFinite(diagnostico.toleranciaMinimaSugerida) &&
    diagnostico.toleranciaMinimaSugerida > 0
      ? diagnostico.toleranciaMinimaSugerida
      : (diagnostico.paresIncompatibles || []).reduce(
          (max, p) => Math.max(max, p.solapamientoMinimoMin || 0),
          0
        );

  contenedor.hidden = false;
  contenedor.innerHTML = `
    <h3 class="diag-title">Sin combinaciones válidas con las restricciones actuales</h3>
    <ul class="diag-list">
      ${(diagnostico.sugerencias || [])
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}
    </ul>
    <div class="diag-actions">
      ${
        maxSolap > 0
          ? `<button type="button" class="btn-solid" data-action="activar-tolerancia" data-minutos="${maxSolap}">Activar tolerancia de ${maxSolap} min</button>`
          : ""
      }
      <button type="button" class="btn-outline" data-action="limpiar-filtros-diag">Restablecer filtros</button>
    </div>
  `;
}

/**
 * Renderiza las tarjetas de recomendaciones en retícula de 3 columnas (RF-VIS-01).
 */
export function renderizarRecomendaciones(
  contenedor,
  footerEl,
  telemetryEl,
  resultado,
  recomendacionActivaId,
  limiteVisible = 6,
  opciones = {}
) {
  if (!contenedor) {
    return;
  }

  const { mapaColores: mapaColoresExt = null, animarEntrada = false } = opciones;

  if (!resultado) {
    if (telemetryEl) {
      telemetryEl.textContent = "ESPERANDO SELECCIÓN";
    }
    if (footerEl) {
      footerEl.hidden = true;
    }
    contenedor.classList?.remove("is-entering");
    contenedor.innerHTML = `
      <div class="empty-onboarding">
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <span class="onboarding-step-num">PASO 01</span>
            <h3 class="onboarding-step-title">Selecciona tus materias</h3>
            <p class="onboarding-step-desc">
              Explora por grupo o asignatura en el panel izquierdo y marca las materias que deseas cursar.
            </p>
          </div>
          <div class="onboarding-step">
            <span class="onboarding-step-num">PASO 02</span>
            <h3 class="onboarding-step-title">Ajusta filtros y prioridad</h3>
            <p class="onboarding-step-desc">
              Restringe días, turno ideal, modalidad o docentes excluidos en las pestañas 02 y 03.
            </p>
          </div>
          <div class="onboarding-step">
            <span class="onboarding-step-num">PASO 03</span>
            <h3 class="onboarding-step-title">Compara y exporta</h3>
            <p class="onboarding-step-desc">
              Alterna entre las combinaciones recomendadas, ajusta manualmente o exporta en PDF / PNG.
            </p>
          </div>
        </div>
        <div class="onboarding-cta-row">
          <span class="mono-meta">PROCESAMIENTO 100% LOCAL · SIN TIEMPOS DE ESPERA</span>
          <button type="button" class="btn-outline btn-xs" data-action="enfocar-busqueda">
            BUSCAR MATERIAS →
          </button>
        </div>
      </div>
    `;
    return;
  }

  const { recomendaciones = [], estadisticas = {} } = resultado;
  if (telemetryEl) {
    const sufijoLimite = estadisticas.limiteAlcanzado ? " (tope alcanzado)" : "";
    telemetryEl.textContent = `${estadisticas.combinacionesValidas ?? 0} VÁLIDAS · ${
      estadisticas.tiempoMs ?? 0
    } MS${sufijoLimite}`;
  }

  if (recomendaciones.length === 0) {
    if (footerEl) {
      footerEl.hidden = true;
    }
    contenedor.classList?.remove("is-entering");
    contenedor.innerHTML = `
      <div class="rec-empty-cell">
        No se encontraron horarios con la configuración actual. Revisa el diagnóstico arriba para resolver el conflicto.
      </div>
    `;
    return;
  }

  const mapaColores = mapaColoresExt ? new Map(mapaColoresExt) : new Map();
  const visibles = recomendaciones.slice(0, limiteVisible);

  if (contenedor.classList) {
    if (animarEntrada) {
      contenedor.classList.remove("is-entering");
      void contenedor.offsetWidth;
      contenedor.classList.add("is-entering");
    } else {
      contenedor.classList.remove("is-entering");
    }
  }

  contenedor.innerHTML = visibles
    .map((rec, idx) => {
      const indiceStr = String(idx + 1).padStart(2, "0");
      const isActive = rec.id === recomendacionActivaId;
      const isBest = idx === 0;
      const m = rec.metricas;

      return `
        <button
          type="button"
          class="rec-card ${isActive ? "is-active" : ""} ${isBest ? "is-best" : ""}"
          style="--stagger-i:${idx};"
          data-seleccionar-rec="${escapeHtml(rec.id)}"
        >
          <div class="rec-card-top">
            <div class="rec-score-wrap">
              <span class="rec-score">${escapeHtml(rec.puntaje)}</span>
              <span class="rec-score-label">PTS</span>
            </div>
            <div class="rec-index-wrap">
              ${isBest ? `<span class="rec-best-badge">MEJOR OPCIÓN</span>` : ""}
              ${isActive ? `<span class="rec-active-pill">EN VISTA</span>` : ""}
              <span class="rec-index">${indiceStr}</span>
            </div>
          </div>

          ${
            rec.tieneSolapamiento
              ? `<span class="rec-overlap-badge">⚠ ${m.totalChoques} ${
                  m.totalChoques === 1 ? "choque" : "choques"
                } · ${m.totalMinutosSolapamiento} min</span>`
              : `<span class="rec-clean-badge">SIN CHOQUES</span>`
          }

          <div class="rec-kpi-grid">
            <div class="rec-kpi-cell">
              <span class="rec-kpi-val ${m.diasLibres >= 2 ? "is-good" : ""}">${
        m.diasLibres
      }</span>
              <span class="rec-kpi-lbl">Días libres</span>
            </div>
            <div class="rec-kpi-cell">
              <span class="rec-kpi-val ${m.totalHuecosMin === 0 ? "is-good" : ""}">${
        m.totalHuecosMin
      }m</span>
              <span class="rec-kpi-lbl">Huecos</span>
            </div>
            <div class="rec-kpi-cell" title="${escapeHtml(
              `Máx. ${m.maxClasesEnUnDia ?? 0} mat./día · Prom. ${
                m.promedioClasesPorDiaActivo ?? 0
              }/día`
            )}">
              <span class="rec-kpi-val ${
                (m.diasConPocasClases ?? 0) === 0 ? "is-good" : "is-warn"
              }">${m.diasConPocasClases ?? 0}</span>
              <span class="rec-kpi-lbl">Días 1–2 cls</span>
            </div>
            <div class="rec-kpi-cell">
              <span class="rec-kpi-val ${m.minutosFueraRango > 0 ? "is-warn" : ""}">${
        m.minutosFueraRango
      }m</span>
              <span class="rec-kpi-lbl">Fuera turno</span>
            </div>
          </div>

          <ul class="rec-subjects-list">
            ${rec.registros
              .map((r) => {
                const colorSubj = asignarColorMateria(r.clv_materia, mapaColores);
                return `
                  <li>
                    <span class="rec-subj-main">
                      <span class="rec-subj-dot" style="--subj-color:${escapeHtml(
                        colorSubj
                      )}" aria-hidden="true"></span>
                      <span class="rec-subj-name">${escapeHtml(
                        r.materia || r.clv_materia
                      )}</span>
                    </span>
                    <span class="rec-subj-group">${escapeHtml(r.grupo)}</span>
                  </li>
                `;
              })
              .join("")}
          </ul>
        </button>
      `;
    })
    .join("");

  if (footerEl) {
    footerEl.hidden = recomendaciones.length <= limiteVisible;
  }
}

/**
 * Renderiza el panel de comparación manual para elegir grupo por grupo (RF-VIS-03).
 */
export function renderizarComparadorManual(
  contenedor,
  materiasSeleccionadas = [],
  horariosFiltrados = [],
  horariosTodos = [],
  seleccionManual = []
) {
  if (!contenedor) {
    return;
  }

  if (materiasSeleccionadas.length === 0) {
    contenedor.innerHTML = `<span class="empty-inline">Selecciona materias primero para comparar grupos manualmente.</span>`;
    return;
  }

  const mapaSeleccionActual = new Map(
    seleccionManual.map((r) => [r.clv_materia, r.id || `${r.clv_materia}:${r.grupo}`])
  );

  const mapaPorMateria = new Map();
  for (const reg of horariosFiltrados) {
    if (!mapaPorMateria.has(reg.clv_materia)) {
      mapaPorMateria.set(reg.clv_materia, []);
    }
    mapaPorMateria.get(reg.clv_materia).push(reg);
  }
  for (const reg of horariosTodos) {
    if (!mapaPorMateria.has(reg.clv_materia)) {
      mapaPorMateria.set(reg.clv_materia, [reg]);
    }
  }

  contenedor.innerHTML = materiasSeleccionadas
    .map((clave) => {
      const opciones = mapaPorMateria.get(clave) || [];
      const nombre = opciones[0]?.materia || clave;
      const valorActivo = mapaSeleccionActual.get(clave) || "";

      return `
        <div class="manual-field">
          <label class="field-label" for="manual-select-${escapeHtml(clave)}">
            ${escapeHtml(clave)} · ${escapeHtml(nombre)}
          </label>
          <select
            id="manual-select-${escapeHtml(clave)}"
            class="select-control"
            data-manual-materia="${escapeHtml(clave)}"
          >
            <option value="">— Sin seleccionar —</option>
            ${opciones
              .map((op) => {
                const opId = op.id || `${op.clv_materia}:${op.grupo}`;
                const selected = opId === valorActivo ? "selected" : "";
                return `<option value="${escapeHtml(opId)}" ${selected}>Gpo ${escapeHtml(
                  op.grupo
                )} · ${escapeHtml(op.profesor || "N/D")} (${escapeHtml(
                  formatearHorasCompactas(op.bloques)
                )})</option>`;
              })
              .join("")}
          </select>
        </div>
      `;
    })
    .join("");
}

function calcularRangoHoras(registros = []) {
  let minHora = 7;
  let maxHora = 22;

  for (const reg of registros) {
    for (const b of reg.bloques || []) {
      if (esBloqueValido(b)) {
        minHora = Math.min(minHora, Math.floor(b.inicio_min / 60));
        maxHora = Math.max(maxHora, Math.ceil(b.fin_min / 60));
      }
    }
  }
  return { minHora, maxHora };
}

/**
 * Renderiza la grilla semanal interactiva (LU-SA), advertencias, KPIs y leyenda imprimible (RF-VIS-02).
 */
export function renderizarGrillaSemanal(
  contenedores,
  horarioActivo,
  bloqueInspectorId = "",
  opciones = {}
) {
  const {
    grillaEl,
    tituloEl,
    kpisEl,
    bannerAdvertenciasEl,
    leyendaImpresionEl,
  } = contenedores;

  const { mapaColores: mapaColoresExt = null, animarBloques = false } = opciones;
  const registros = horarioActivo?.registros || [];

  if (tituloEl) {
    tituloEl.textContent =
      registros.length > 0
        ? `${registros.length} MATERIAS · ${horarioActivo.puntaje} PTS`
        : "SIN HORARIO ACTIVO";
  }

  if (kpisEl) {
    if (registros.length > 0 && horarioActivo.metricas) {
      const m = horarioActivo.metricas;
      kpisEl.innerHTML = `
        <span class="kpi-chip">${m.diasLibres} días libres</span>
        <span class="kpi-chip">${m.totalHuecosMin}m huecos</span>
        <span class="kpi-chip">${m.diasConPocasClases ?? 0} días 1–2 cls</span>
        <span class="kpi-chip">${m.totalMinutosSolapamiento}m traslape</span>
      `;
    } else {
      kpisEl.innerHTML = "";
    }
  }

  if (bannerAdvertenciasEl) {
    const advertencias = horarioActivo?.advertencias || [];
    if (advertencias.length > 0) {
      bannerAdvertenciasEl.hidden = false;
      bannerAdvertenciasEl.innerHTML = advertencias
        .map((adv) => `<div>⚠ ${escapeHtml(adv)}</div>`)
        .join("");
    } else {
      bannerAdvertenciasEl.hidden = true;
      bannerAdvertenciasEl.innerHTML = "";
    }
  }

  if (!grillaEl) {
    return;
  }

  if (registros.length === 0) {
    grillaEl.classList?.remove("is-animating-blocks");
    grillaEl.innerHTML = `
      <div class="grilla-empty-state">
        <svg class="grilla-empty-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" stroke="currentColor" stroke-width="1.4" />
          <line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" stroke-width="1.4" />
          <line x1="9" y1="9" x2="9" y2="20" stroke="currentColor" stroke-width="1.4" />
          <line x1="15" y1="9" x2="15" y2="20" stroke="currentColor" stroke-width="1.4" />
        </svg>
        <span>Aquí aparecerá tu horario semanal interactivo de lunes a sábado al elegir materias o cargar una recomendación.</span>
        <span class="grilla-empty-hint">CONSEJO: HAZ CLIC EN CUALQUIER BLOQUE PARA INSPECCIONAR DOCENTE, SALÓN Y EXCLUSIONES</span>
      </div>
    `;
    if (leyendaImpresionEl) {
      leyendaImpresionEl.innerHTML = "";
    }
    return;
  }

  const mapaColores = mapaColoresExt ? new Map(mapaColoresExt) : new Map();
  for (const reg of registros) {
    asignarColorMateria(reg.clv_materia, mapaColores);
  }

  const { minHora, maxHora } = calcularRangoHoras(registros);
  const pxPorHora = 48;
  const totalHoras = Math.max(1, maxHora - minHora);
  const alturaPx = totalHoras * pxPorHora;
  const inicioMinBase = minHora * 60;

  const porDia = new Map(DIAS_SEMANA.map((d) => [d, []]));
  for (const reg of registros) {
    for (const bloque of reg.bloques || []) {
      if (esBloqueValido(bloque) && porDia.has(bloque.dia)) {
        porDia.get(bloque.dia).push({
          ...bloque,
          registro: reg,
          color: asignarColorMateria(reg.clv_materia, mapaColores),
          uid: `${reg.id || `${reg.clv_materia}:${reg.grupo}`}_${bloque.dia}_${bloque.inicio_min}`,
        });
      }
    }
  }

  let marcasHorasHtml = "";
  let lineasHorizontalesHtml = "";
  for (let h = 0; h < totalHoras; h += 1) {
    const topPx = h * pxPorHora;
    const labelHora = `${String(minHora + h).padStart(2, "0")}:00`;
    marcasHorasHtml += `<div class="grilla-hour-label" style="top:${topPx}px;height:${pxPorHora}px;">${labelHora}</div>`;
    lineasHorizontalesHtml += `<div class="grilla-hour-line" style="top:${topPx}px;height:${pxPorHora}px;"></div>`;
  }

  let bloqueIdx = 0;
  const columnasDiasHtml = DIAS_SEMANA.map((dia) => {
    const carriles = calcularCarrilesSolapados(porDia.get(dia));
    const bloquesHtml = carriles
      .map((item) => {
        const top = ((item.inicio_min - inicioMinBase) / 60) * pxPorHora;
        const height = Math.max(22, ((item.fin_min - item.inicio_min) / 60) * pxPorHora - 2);
        const widthPct = 100 / item.totalCols;
        const leftPct = item.colIndex * widthPct;
        const reg = item.registro;
        const isSelected = item.uid === bloqueInspectorId;
        const ordenBloque = bloqueIdx;
        bloqueIdx += 1;

        return `
          <button
            type="button"
            class="class-block ${item.enChoque ? "is-overlap" : ""} ${
          isSelected ? "is-selected" : ""
        }"
            style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);--block-accent:${
          item.color
        };--block-i:${ordenBloque};"
            data-inspeccionar-bloque="${escapeHtml(item.uid)}"
            data-registro-id="${escapeHtml(reg.id || `${reg.clv_materia}:${reg.grupo}`)}"
            data-clv-materia="${escapeHtml(reg.clv_materia || "")}"
          >
            <span class="block-time">${item.enChoque ? "⚠ " : ""}${escapeHtml(
          item.hora_texto
        )}</span>
            <span class="block-title">${escapeHtml(reg.materia || reg.clv_materia)}</span>
            <span class="block-meta">Gpo ${escapeHtml(reg.grupo)} · ${escapeHtml(
          reg.salon || "S/S"
        )}</span>
          </button>
        `;
      })
      .join("");

    return `
      <div class="grilla-day-col" style="height:${alturaPx}px;">
        ${lineasHorizontalesHtml}
        ${bloquesHtml}
      </div>
    `;
  }).join("");

  if (grillaEl.classList) {
    if (animarBloques) {
      grillaEl.classList.remove("is-animating-blocks");
      void grillaEl.offsetWidth;
      grillaEl.classList.add("is-animating-blocks");
    } else {
      grillaEl.classList.remove("is-animating-blocks");
    }
  }

  grillaEl.innerHTML = `
    <div class="grilla-corner">HORA</div>
    ${DIAS_SEMANA.map((d) => {
      const esLibre = (porDia.get(d) || []).length === 0;
      return `<div class="grilla-day-header ${esLibre ? "is-free-day" : ""}"><span>${
        NOMBRES_DIAS[d]
      }</span>${esLibre ? `<span class="day-free-pill">LIBRE</span>` : ""}</div>`;
    }).join("")}
    <div class="grilla-time-axis" style="height:${alturaPx}px;">${marcasHorasHtml}</div>
    ${columnasDiasHtml}
  `;

  if (leyendaImpresionEl) {
    leyendaImpresionEl.innerHTML = registros
      .map((r) => {
        const color = asignarColorMateria(r.clv_materia, mapaColores);
        return `
          <div class="leyenda-item" style="border-left: 4px solid ${color};">
            <strong>${escapeHtml(r.clv_materia)} · ${escapeHtml(r.materia)}</strong><br />
            Gpo ${escapeHtml(r.grupo)} · ${escapeHtml(r.profesor || "Sin profesor")}<br />
            Salón: ${escapeHtml(r.salon || "S/S")} · ${escapeHtml(r.tipo_clase || "")}
          </div>
        `;
      })
      .join("");
  }
}

/**
 * Renderiza el detalle del bloque seleccionado en la grilla con acciones rápidas.
 */
export function renderizarInspectorBloque(contenedor, registro, colorMateria = "") {
  if (!contenedor) {
    return;
  }

  if (!registro) {
    contenedor.hidden = true;
    contenedor.innerHTML = "";
    return;
  }

  const cupoTxt =
    registro.cupo !== null && registro.cupo !== undefined
      ? `Cupo: ${registro.cupo}`
      : "Cupo: N/D";

  if (colorMateria && contenedor.style?.setProperty) {
    contenedor.style.setProperty("--inspector-accent", colorMateria);
  }

  contenedor.hidden = false;
  contenedor.innerHTML = `
    <div class="inspector-bloque-info">
      <div class="inspector-bloque-title">
        ${escapeHtml(registro.clv_materia)} · ${escapeHtml(registro.materia)} (Grupo ${escapeHtml(
    registro.grupo
  )})
      </div>
      <div class="inspector-meta-pills">
        <span class="inspector-meta-pill">Docente: ${escapeHtml(
          registro.profesor || "N/D"
        )}</span>
        <span class="inspector-meta-pill">Salón: ${escapeHtml(
          registro.salon || "S/S"
        )}</span>
        <span class="inspector-meta-pill">${escapeHtml(
          registro.tipo_clase || "N/D"
        )}</span>
        <span class="inspector-meta-pill">${escapeHtml(cupoTxt)}</span>
      </div>
      <div class="inspector-bloque-meta">
        Horario completo: ${escapeHtml(formatearHorasCompactas(registro.bloques))}
      </div>
    </div>
    <div class="inspector-bloque-actions">
      ${
        registro.profesor
          ? `<button type="button" class="btn-outline btn-xs" data-excluir-profesor="${escapeHtml(
              registro.profesor
            )}">Excluir profesor</button>`
          : ""
      }
      <button type="button" class="btn-outline btn-xs" data-excluir-grupo="${escapeHtml(
        `${registro.clv_materia}:${registro.grupo}`
      )}">Excluir este grupo</button>
      <button type="button" class="btn-outline btn-xs" data-cerrar-inspector-bloque>Cerrar</button>
    </div>
  `;
}

/**
 * Exporta el horario activo como imagen PNG de alta resolución mediante Canvas 2D (RF-VIS-03).
 */
export function exportarHorarioPNG(horarioActivo, metadata = null) {
  if (typeof document === "undefined") {
    return false;
  }
  const registros = horarioActivo?.registros || [];
  if (registros.length === 0) {
    return false;
  }

  const scale = 2;
  const width = 1280;
  const { minHora, maxHora } = calcularRangoHoras(registros);
  const totalHoras = Math.max(1, maxHora - minHora);
  const headerH = 74;
  const colHeadH = 34;
  const pxPorHora = 44;
  const gridH = totalHoras * pxPorHora;
  const filasLeyenda = Math.ceil(registros.length / 2);
  const legendH = 26 + filasLeyenda * 46;
  const height = headerH + colHeadH + gridH + legendH + 20;

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return false;
  }
  ctx.scale(scale, scale);

  ctx.fillStyle = "#121317";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#2d2d2e";
  ctx.fillRect(0, 0, width, headerH);
  ctx.strokeStyle = "#3a3b40";
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  ctx.fillStyle = "#f6f7f7";
  ctx.font = "bold 20px 'Space Grotesk', system-ui, sans-serif";
  ctx.fillText("HORARIO SEMANAL GENERADO", 24, 32);

  const subtitulo = metadata
    ? `${metadata.etiqueta_semestre || metadata.semestre} · ${
        metadata.nombre_carrera || ""
      } · ${horarioActivo.puntaje ?? 0} PTS`
    : `${registros.length} materias · ${horarioActivo.puntaje ?? 0} PTS`;
  ctx.fillStyle = "#969697";
  ctx.font = "12px 'JetBrains Mono', monospace";
  ctx.fillText(subtitulo, 24, 54);

  const axisW = 70;
  const dayW = (width - axisW) / DIAS_SEMANA.length;
  const gridTop = headerH + colHeadH;

  ctx.fillStyle = "#17181d";
  ctx.fillRect(0, headerH, width, colHeadH);
  ctx.strokeStyle = "#26272b";
  ctx.beginPath();
  ctx.moveTo(0, gridTop);
  ctx.lineTo(width, gridTop);
  ctx.stroke();

  ctx.fillStyle = "#f6f7f7";
  ctx.font = "bold 12px 'JetBrains Mono', monospace";
  ctx.fillText("HORA", 18, headerH + 21);

  DIAS_SEMANA.forEach((dia, idx) => {
    const x = axisW + idx * dayW;
    ctx.strokeStyle = "#26272b";
    ctx.beginPath();
    ctx.moveTo(x, headerH);
    ctx.lineTo(x, gridTop + gridH);
    ctx.stroke();
    ctx.fillStyle = "#f6f7f7";
    ctx.fillText(NOMBRES_DIAS[dia], x + 14, headerH + 21);
  });

  for (let h = 0; h < totalHoras; h += 1) {
    const y = gridTop + h * pxPorHora;
    ctx.strokeStyle = "#1d1e22";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = "#86878c";
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillText(`${String(minHora + h).padStart(2, "0")}:00`, 16, y + 16);
  }

  const mapaColores = new Map();
  const inicioMinBase = minHora * 60;
  const porDia = new Map(DIAS_SEMANA.map((d) => [d, []]));

  for (const reg of registros) {
    const color = asignarColorMateria(reg.clv_materia, mapaColores);
    for (const b of reg.bloques || []) {
      if (esBloqueValido(b) && porDia.has(b.dia)) {
        porDia.get(b.dia).push({ ...b, registro: reg, color });
      }
    }
  }

  DIAS_SEMANA.forEach((dia, diaIdx) => {
    const carriles = calcularCarrilesSolapados(porDia.get(dia));
    const colX = axisW + diaIdx * dayW;

    for (const item of carriles) {
      const y = gridTop + ((item.inicio_min - inicioMinBase) / 60) * pxPorHora + 1;
      const h = Math.max(20, ((item.fin_min - item.inicio_min) / 60) * pxPorHora - 2);
      const w = dayW / item.totalCols - 4;
      const x = colX + item.colIndex * (dayW / item.totalCols) + 2;

      ctx.fillStyle = item.enChoque ? "#241d19" : "#1a1c23";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = item.enChoque ? "#d4945a" : "#3a3b40";
      ctx.strokeRect(x, y, w, h);

      ctx.fillStyle = item.color;
      ctx.fillRect(x, y, 3, h);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 6, y + 2, w - 10, h - 4);
      ctx.clip();

      ctx.fillStyle = "#969697";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText(item.hora_texto || "", x + 7, y + 13);

      ctx.fillStyle = "#f6f7f7";
      ctx.font = "bold 11px 'Space Grotesk', sans-serif";
      ctx.fillText(item.registro.materia || item.registro.clv_materia, x + 7, y + 27);

      if (h > 36) {
        ctx.fillStyle = "#86878c";
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText(
          `Gpo ${item.registro.grupo} · ${item.registro.salon || "S/S"}`,
          x + 7,
          y + 40
        );
      }
      ctx.restore();
    }
  });

  const legendTop = gridTop + gridH + 14;
  ctx.strokeStyle = "#26272b";
  ctx.beginPath();
  ctx.moveTo(0, legendTop - 6);
  ctx.lineTo(width, legendTop - 6);
  ctx.stroke();

  const colLegendW = (width - 48) / 2;
  registros.forEach((reg, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 24 + col * colLegendW;
    const y = legendTop + row * 44;
    const color = asignarColorMateria(reg.clv_materia, mapaColores);

    ctx.fillStyle = color;
    ctx.fillRect(x, y + 4, 4, 30);

    ctx.fillStyle = "#f6f7f7";
    ctx.font = "bold 12px 'Space Grotesk', sans-serif";
    ctx.fillText(`${reg.clv_materia} · ${reg.materia} (Gpo ${reg.grupo})`, x + 12, y + 17);

    ctx.fillStyle = "#969697";
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillText(
      `${reg.profesor || "Sin docente"} · Salón ${reg.salon || "S/S"}`,
      x + 12,
      y + 33
    );
  });

  const url = canvas.toDataURL("image/png");
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `horario-${metadata?.etiqueta_semestre || "semanal"}.png`;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  return true;
}
