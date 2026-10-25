// Tablero Kanban: arma las columnas y las fichas a partir de /api/admin/tablero, y deja
// arrastrar las fichas entre columnas (drag-and-drop nativo del navegador, sin librerías).
// Los textos salen de public/i18n/panel/{comun,tablero}.<idioma>.json (tp() viene de
// public/js/panel-i18n.js).

let ESTADO = { columnas: [], fichas: [], cliente: null };
let filtroBusqueda = '';
let columnaActivaMobile = null;
let avisoLeadInicializado = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || tp('comun.error_red'));
  return data;
}

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ORIGEN_INFO = {
  formulario: { icon: 'fa-regular fa-envelope', clave: 'tablero.origen_formulario' },
  whatsapp_texto: { icon: 'fa-brands fa-whatsapp', clave: 'tablero.origen_whatsapp' },
  whatsapp_audio: { icon: 'fa-solid fa-microphone', clave: 'tablero.origen_whatsapp_audio' },
  importado: { icon: 'fa-solid fa-file-csv', clave: 'tablero.origen_importado' },
  meta_ads: { icon: 'fa-brands fa-meta', clave: 'tablero.origen_meta_ads' }
};

function origenInfo(origen) {
  const info = ORIGEN_INFO[origen];
  if (info) return { icon: info.icon, label: tp(info.clave) };
  return { icon: 'fa-solid fa-message', label: origen || '' };
}

function formatearFecha(iso) {
  return PanelI18n.fecha(iso, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatearMonto(monto) {
  if (monto === null || monto === undefined || monto === '') return null;
  return '$ ' + PanelI18n.numero(Math.round(Number(monto)));
}

// Los nombres de las columnas los puede cambiar el dueño y vienen en el idioma del negocio
// (español/inglés/portugués), así que además de los ids fijos de las columnas por defecto
// se reconocen las palabras más comunes en los 3 idiomas. Mismo criterio que
// server/services/ciclo-fichas-frias.js.
function esColumnaGanada(columna) {
  return columna?.id === 'ganado' || /concretad|ganad|vend|closed|won\b|sold|conclu[ií]d|fechad|ganh/i.test(columna?.nombre || '');
}

function esColumnaPerdida(columna) {
  return columna?.id === 'perdido' || /perdid|no avanz|descart|cancel|lost|did not advance|not advance|n[aã]o avan/i.test(columna?.nombre || '');
}

// Una ficha se considera "fría" si hace más de DIAS_FRIO días que no hay ningún mensaje
// nuevo del cliente, Y todavía está en una etapa activa (no se cuenta una venta ya
// concretada o ya descartada, ahí no hay nada que "seguir"). Es solo un aviso visual para
// el equipo - no manda ningún mensaje solo, eso sería proactivo y tendría costo/sería spam.
const DIAS_FRIO = 5;

function fichaEstaFria(ficha, columna) {
  if (!columna || esColumnaGanada(columna) || esColumnaPerdida(columna)) return false;
  const ultima = new Date(ficha.fecha_hora_ultimo_mensaje || ficha.fecha_hora_recibido).getTime();
  return Date.now() - ultima > DIAS_FRIO * 24 * 60 * 60 * 1000;
}

function crearTarjeta(ficha, columna) {
  const el = document.createElement('div');
  const fria = fichaEstaFria(ficha, columna);
  el.className = 'premium-card' + (fria ? ' card-fria' : '');
  el.draggable = true;
  el.dataset.id = ficha._id;

  const origen = origenInfo(ficha.ultimo_origen || ficha.origen);
  const montoTexto = formatearMonto(ficha.monto);

  el.innerHTML = `
    <div class="card-header">
      <div class="card-user-info">
        <div class="card-icon"><i class="${origen.icon}"></i></div>
        <div class="card-username-wrap">
          <div class="card-username">${esc(ficha.nombre || ficha.contacto)}</div>
          <span class="card-tag">${esc(ficha.contacto)}</span>
        </div>
      </div>
      ${fria ? `<span class="card-frio-badge" title="${esc(tp('tablero.frio_title', { dias: DIAS_FRIO }))}"><i class="fa-solid fa-snowflake"></i></span>` : ''}
    </div>
    <div class="card-body">"${esc((ficha.ultimo_mensaje || ficha.mensaje || '').slice(0, 100))}"</div>
    ${(ficha.etiquetas || []).length ? `<div class="card-etiquetas">${(ficha.etiquetas || []).map((e) => `<span class="etiqueta-chip">${esc(e)}</span>`).join('')}</div>` : ''}
    ${ficha.asignado_a ? `<div class="card-asignado"><i class="fa-regular fa-user"></i> ${esc(ficha.asignado_a.nombre)}</div>` : ''}
    <div class="card-divider"></div>
    <div class="card-footer">
      ${montoTexto ? `<span class="card-value">${montoTexto}</span>` : `<span class="card-value sin-monto">${esc(tp('tablero.sin_monto'))}</span>`}
      <span class="card-date"><i class="fa-regular fa-clock"></i> ${formatearFecha(ficha.fecha_hora_ultimo_mensaje || ficha.fecha_hora_recibido)}</span>
    </div>
  `;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', ficha._id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', () => abrirFicha(ficha._id));

  return el;
}

function fichasFiltradas() {
  if (!filtroBusqueda) return ESTADO.fichas;
  const q = filtroBusqueda.toLowerCase();
  return ESTADO.fichas.filter((f) =>
    (f.nombre || '').toLowerCase().includes(q) ||
    (f.contacto || '').toLowerCase().includes(q) ||
    (f.ultimo_mensaje || f.mensaje || '').toLowerCase().includes(q)
  );
}

function renderTablero() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  const columnasOrdenadas = [...ESTADO.columnas].sort((a, b) => a.posicion - b.posicion);
  const fichasVisibles = fichasFiltradas();

  if (!columnaActivaMobile || !columnasOrdenadas.some((c) => c.id === columnaActivaMobile)) {
    columnaActivaMobile = columnasOrdenadas[0]?.id || null;
  }

  const conteos = {};

  columnasOrdenadas.forEach((columna) => {
    const col = document.createElement('div');
    col.className = 'kanban-column' + (columna.id === columnaActivaMobile ? ' mobile-active' : '');
    col.dataset.columnaId = columna.id;

    const fichasColumna = fichasVisibles
      .filter((f) => f.columna_id === columna.id)
      .sort((a, b) => a.posicion - b.posicion);
    conteos[columna.id] = fichasColumna.length;

    const badgeClase = 'column-count';
    col.innerHTML = `
      <div class="column-header">
        <span class="column-title">${esc(columna.nombre)}</span>
        <span class="${badgeClase}">${fichasColumna.length}</span>
      </div>
    `;

    const lista = document.createElement('div');
    lista.className = 'cards-container';
    if (fichasColumna.length === 0) {
      lista.innerHTML = filtroBusqueda
        ? `<div class="cards-empty">${esc(tp('tablero.sin_resultados'))}</div>`
        : `<div class="cards-empty">${esc(tp('tablero.sin_fichas'))}</div>`;
    } else {
      fichasColumna.forEach((f) => lista.appendChild(crearTarjeta(f, columna)));
    }
    col.appendChild(lista);

    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop-hover');
    });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drop-hover');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-hover');
      const fichaId = e.dataTransfer.getData('text/plain');
      const nuevaPosicion = fichasColumna.length; // se agrega al final de la columna destino
      await moverFicha(fichaId, columna.id, nuevaPosicion);
    });

    board.appendChild(col);
  });

  renderPestanasMobile(columnasOrdenadas, conteos);
  actualizarCabecera();
}

function renderPestanasMobile(columnasOrdenadas, conteos) {
  const tabs = document.getElementById('stage-tabs');
  tabs.innerHTML = '';
  columnasOrdenadas.forEach((columna) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stage-chip' + (columna.id === columnaActivaMobile ? ' active' : '');
    chip.innerHTML = `${esc(columna.nombre)} <span class="stage-count">${conteos[columna.id] ?? 0}</span>`;
    chip.addEventListener('click', () => {
      columnaActivaMobile = columna.id;
      renderTablero();
    });
    tabs.appendChild(chip);
  });
}

// El idioma del panel lo define el negocio (clientes.idioma). La cookie con la que arrancó
// la página la pone el servidor al loguearse - si una sesión vieja (abierta antes de que
// existiera esto) no la tiene, o no coincide con la del negocio, se corrige y se recarga
// una sola vez (sessionStorage evita un bucle de recargas si algo saliera mal).
function sincronizarIdiomaConElNegocio() {
  const idiomaNegocio = ESTADO.cliente?.idioma;
  if (!idiomaNegocio || idiomaNegocio === PanelI18n.idioma) return;
  try {
    if (sessionStorage.getItem('idioma_sincronizado') === idiomaNegocio) return;
    sessionStorage.setItem('idioma_sincronizado', idiomaNegocio);
  } catch {
    return;
  }
  PanelI18n.cambiarIdioma(idiomaNegocio);
}

function actualizarCabecera() {
  if (ESTADO.cliente) {
    document.getElementById('user-nombre').textContent = ESTADO.cliente.nombre || '';
    document.getElementById('user-slug').textContent = ESTADO.cliente.slug || '';
    const iniciales = (ESTADO.cliente.nombre || '?')
      .split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    document.getElementById('user-avatar').textContent = iniciales || '?';
    sincronizarIdiomaConElNegocio();
  }

  if (ESTADO.usuario) {
    const esGerencia = ESTADO.usuario.rol === 'gerencia';
    document.getElementById('user-rol').textContent = esGerencia
      ? tp('tablero.rol_gerencia')
      : `${ESTADO.usuario.nombre} · ${ESTADO.usuario.departamento}`;
    document.getElementById('nav-empleados').hidden = !esGerencia;
    const planConEstadisticas = ESTADO.cliente?.plan === 'premium' || ESTADO.cliente?.plan === 'elite';
    document.getElementById('nav-estadisticas').hidden = !(esGerencia && planConEstadisticas);
    document.getElementById('nav-salon').hidden = !(ESTADO.cliente?.plan === 'elite');
    document.getElementById('aviso-lead-label').hidden = !esGerencia;
    document.getElementById('resumen-semanal-label').hidden = !esGerencia;
    document.getElementById('btn-config-general').hidden = !esGerencia;
    const btnExportar = document.getElementById('btn-exportar-csv');
    btnExportar.hidden = !esGerencia;
    btnExportar.href = '/api/admin/fichas/exportar';
    const btnConectarWhatsapp = document.getElementById('btn-conectar-whatsapp');
    btnConectarWhatsapp.hidden = !esGerencia;
    btnConectarWhatsapp.href = `/conectar-whatsapp.html?slug=${encodeURIComponent(ESTADO.cliente?.slug || '')}`;
    const btnConectarMetaAds = document.getElementById('btn-conectar-meta-ads');
    btnConectarMetaAds.hidden = !esGerencia;
    btnConectarMetaAds.href = `/conectar-meta-ads.html?slug=${encodeURIComponent(ESTADO.cliente?.slug || '')}`;
    document.getElementById('btn-importar-csv').hidden = !esGerencia;
    document.getElementById('btn-mensajes-masivos').hidden = !esGerencia;
    // Solo la primera vez - si se vuelve a pisar en cada refresh automático (cada 20s),
    // se perdería el clic del usuario si tocó el checkbox justo antes de que refresque.
    if (!avisoLeadInicializado && esGerencia) {
      document.getElementById('aviso-lead-checkbox').checked = ESTADO.cliente?.avisos_lead_email !== false;
      document.getElementById('resumen-semanal-checkbox').checked = ESTADO.cliente?.resumen_semanal_email !== false;
      avisoLeadInicializado = true;
    }
  }

  const hoy = new Date().toDateString();
  const nuevasHoy = ESTADO.fichas.filter((f) => new Date(f.fecha_hora_recibido).toDateString() === hoy).length;
  document.getElementById('metrics-nuevas-hoy').textContent = tp('tablero.nuevas_hoy', { n: nuevasHoy });

  const columnasPorId = Object.fromEntries(ESTADO.columnas.map((c) => [c.id, c]));
  const frias = ESTADO.fichas.filter((f) => fichaEstaFria(f, columnasPorId[f.columna_id])).length;
  document.getElementById('metrics-frias').hidden = frias === 0;
  document.getElementById('metrics-frias-texto').textContent = tp('tablero.sin_avance', { n: frias });

  const primeraColumna = [...ESTADO.columnas].sort((a, b) => a.posicion - b.posicion)[0];
  const hayPendientes = primeraColumna && ESTADO.fichas.some((f) => f.columna_id === primeraColumna.id);
  document.getElementById('notif-badge').hidden = !hayPendientes;

  renderEstadoBanner();
}

// Número de WhatsApp de FrontyBack para coordinar la reactivación mientras no está
// conectado el cobro automático con MercadoPago - una vez que esté, esto apunta al link
// de pago de cada cliente en lugar de a este chat.
const WHATSAPP_FRONTYBACK = '5491162195243';

function diasHasta(fechaIso) {
  if (!fechaIso) return null;
  return Math.ceil((new Date(fechaIso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function renderEstadoBanner() {
  const banner = document.getElementById('estado-banner');
  const estado = ESTADO.cliente?.estado_pago;
  if (!ESTADO.cliente?.whatsapp_pago_pendiente) document.getElementById('pago-pendiente-detalle').hidden = true;

  if (estado === 'vencido_gracia') {
    const dias = Math.max(diasHasta(ESTADO.cliente.gracia_termina) ?? 0, 0);
    banner.className = 'estado-banner gracia';
    banner.innerHTML = `
      <span>${tpn('tablero.banner_gracia', dias)}</span>
      <button type="button" class="btn-reactivar" id="btn-reactivar">${esc(tp('tablero.reactivar'))}</button>
    `;
    banner.hidden = false;
    document.getElementById('btn-reactivar').addEventListener('click', abrirLinkDePago);
  } else if (estado === 'vencido_cortado') {
    banner.className = 'estado-banner cortado';
    banner.innerHTML = `
      <span>${tp('tablero.banner_cortado')}</span>
      <button type="button" class="btn-reactivar" id="btn-reactivar">${esc(tp('tablero.reactivar'))}</button>
    `;
    banner.hidden = false;
    document.getElementById('btn-reactivar').addEventListener('click', abrirLinkDePago);
  } else if (ESTADO.cliente?.whatsapp_pago_pendiente) {
    banner.className = 'estado-banner pago-pendiente';
    banner.innerHTML = `
      <span>${tp('tablero.banner_pago_wa')}</span>
      <button type="button" class="btn-reactivar" id="btn-ayuda-pago-whatsapp">${esc(tp('tablero.como_lo_soluciono'))}</button>
    `;
    banner.hidden = false;
    const detalle = document.getElementById('pago-pendiente-detalle');
    // El mensaje le llega a FrontyBack (soporte), que lo lee en español.
    document.getElementById('pago-pendiente-wa').href =
      `https://wa.me/${WHATSAPP_FRONTYBACK}?text=${encodeURIComponent('Hola! Me aparece un aviso de que tengo que cargar un método de pago en mi WhatsApp Business de Meta. ¿Me ayudás?')}`;
    document.getElementById('btn-ayuda-pago-whatsapp').addEventListener('click', () => {
      detalle.hidden = !detalle.hidden;
    });
  } else {
    banner.hidden = true;
  }
}

// Al tocar "Reactivar ahora" se genera (o reusa) el link de suscripción de Mercado Pago y
// se abre en una pestaña nueva. Si por algo falla (plan sin configurar, Mercado Pago caído),
// cae de respaldo al WhatsApp de FrontyBack para resolverlo a mano.
async function abrirLinkDePago() {
  const boton = document.getElementById('btn-reactivar');
  if (!boton) return;
  const textoOriginal = boton.textContent;
  boton.textContent = tp('tablero.generando_link');
  boton.disabled = true;
  try {
    const res = await fetch('/api/admin/pago/link', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.link) throw new Error(data.error || tp('tablero.error_link_pago'));
    window.open(data.link, '_blank', 'noopener');
  } catch (err) {
    console.error('No se pudo generar el link de pago:', err.message);
    window.open(`https://wa.me/${WHATSAPP_FRONTYBACK}?text=${encodeURIComponent('Hola! Quiero reactivar mi plan del CRM (' + (ESTADO.cliente.slug || '') + ')')}`, '_blank', 'noopener');
  } finally {
    boton.textContent = textoOriginal;
    boton.disabled = false;
  }
}

async function moverFicha(fichaId, columnaId, posicion) {
  const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
  if (!ficha) return;
  ficha.columna_id = columnaId;
  ficha.posicion = posicion;
  renderTablero();
  try {
    await api(`/api/admin/fichas/${fichaId}/mover`, {
      method: 'PUT',
      body: JSON.stringify({ columna_id: columnaId, posicion })
    });
  } catch (err) {
    alert(tp('tablero.error_mover', { mensaje: err.message }));
    await cargarTablero();
  }
}

async function guardarMonto(fichaId, valorInput, statusEl) {
  const crudo = valorInput.value.trim();
  statusEl.textContent = tp('comun.guardando');
  try {
    const data = await api(`/api/admin/fichas/${fichaId}/monto`, {
      method: 'PUT',
      body: JSON.stringify({ monto: crudo === '' ? null : crudo })
    });
    const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
    if (ficha) ficha.monto = data.monto;
    statusEl.textContent = tp('comun.guardado');
    renderTablero();
    setTimeout(() => { statusEl.textContent = ''; }, 1800);
  } catch (err) {
    statusEl.textContent = tp('comun.error_guardar', { mensaje: err.message });
  }
}

async function guardarEtiquetas(fichaId, etiquetas) {
  const data = await api(`/api/admin/fichas/${fichaId}/etiquetas`, {
    method: 'PUT',
    body: JSON.stringify({ etiquetas })
  });
  const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
  if (ficha) ficha.etiquetas = data.etiquetas;
  abrirFicha(fichaId);
  renderTablero();
}

async function guardarNota(fichaId, textoInput, statusEl) {
  const texto = textoInput.value.trim();
  if (!texto) return;
  statusEl.textContent = tp('comun.guardando');
  try {
    const data = await api(`/api/admin/fichas/${fichaId}/notas`, {
      method: 'POST',
      body: JSON.stringify({ texto })
    });
    const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
    if (ficha) ficha.notas_internas = [...(ficha.notas_internas || []), data.nota];
    textoInput.value = '';
    statusEl.textContent = '';
    abrirFicha(fichaId);
  } catch (err) {
    statusEl.textContent = tp('comun.error_guardar', { mensaje: err.message });
  }
}

async function responderWhatsapp(fichaId, textoInput, statusEl) {
  const texto = textoInput.value.trim();
  if (!texto) return;
  statusEl.textContent = tp('tablero.enviando');
  statusEl.className = 'ficha-monto-status';
  try {
    const data = await api(`/api/admin/fichas/${fichaId}/responder`, {
      method: 'POST',
      body: JSON.stringify({ texto })
    });
    const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
    if (ficha) {
      ficha.historial = [...(ficha.historial || []), { tipo: 'respuesta_saliente', canal: 'whatsapp_texto', contenido: texto, fecha_hora: new Date().toISOString() }];
    }
    textoInput.value = '';
    if (data.viaPlantilla) {
      statusEl.textContent = tp('tablero.enviado_plantilla');
      setTimeout(() => abrirFicha(fichaId), 2800);
    } else {
      statusEl.textContent = '';
      abrirFicha(fichaId);
    }
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = 'ficha-monto-status error';
  }
}

function abrirFicha(fichaId) {
  const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
  if (!ficha) return;

  const columna = ESTADO.columnas.find((c) => c.id === ficha.columna_id);
  const badgeClase = columna && esColumnaGanada(columna) ? 'card-status-badge success' : 'card-status-badge';

  const historial = (ficha.historial || [])
    .slice()
    .reverse()
    .map((h) => {
      const info = origenInfo(h.origen || h.canal);
      return `
      <div class="hist-item hist-${h.tipo}">
        <div class="hist-meta">${esc(h.tipo === 'respuesta_saliente' ? tp('tablero.hist_respondimos') : tp('tablero.hist_escribio'))} · ${esc(info.label)} · ${formatearFecha(h.fecha_hora)}</div>
        <div class="hist-texto">${esc(h.contenido)}</div>
      </div>
    `;
    }).join('');

  document.getElementById('ficha-body').innerHTML = `
    <h2>${esc(ficha.nombre || tp('tablero.sin_nombre'))}</h2>
    <p class="ficha-contacto">${esc(ficha.contacto)}</p>
    <p class="ficha-meta">
      <span>${esc(tp('tablero.recibido'))} ${formatearFecha(ficha.fecha_hora_recibido)}</span>
      ${columna ? `<span class="${badgeClase}">${esc(columna.nombre)}</span>` : ''}
    </p>

    <div class="ficha-etiquetas">
      ${(ficha.etiquetas || []).map((e) => `<span class="etiqueta-chip">${esc(e)}<button type="button" class="etiqueta-quitar" data-etiqueta="${esc(e)}">&times;</button></span>`).join('')}
      <input id="etiqueta-input" type="text" maxlength="30" placeholder="${esc(tp('tablero.etiqueta_ph'))}">
    </div>

    ${columna && esColumnaGanada(columna) && ESTADO.cliente?.google_review_link && /^\+?[\d\s-]{6,20}$/.test(ficha.contacto || '') ? `
      <a class="btn-ghost" id="btn-pedir-resena" style="display: block; text-align: center; margin: 10px 0; text-decoration: none; color: #2bb673; border-color: rgba(43,182,115,0.3);" target="_blank" rel="noopener"
         href="https://wa.me/${esc((ficha.contacto || '').replace(/\D/g, ''))}?text=${encodeURIComponent(tp('tablero.resena_mensaje', { nombre: ficha.nombre || '', link: ESTADO.cliente.google_review_link }))}">
        <i class="fa-brands fa-google"></i> ${esc(tp('tablero.pedir_resena'))}
      </a>
    ` : ''}

    <div class="ficha-monto">
      <div>
        <label for="monto-input">${esc(tp('tablero.valor_negocio'))}</label>
        <input id="monto-input" type="number" min="0" step="1" placeholder="${esc(tp('tablero.sin_cargar'))}" value="${ficha.monto ?? ''}">
      </div>
      <button type="button" class="btn-ghost" id="monto-guardar">${esc(tp('comun.guardar'))}</button>
    </div>
    <p class="ficha-monto-status" id="monto-status"></p>

    <div class="ficha-mover">
      <label for="mover-select">${esc(tp('tablero.etapa'))}</label>
      <select id="mover-select">
        ${[...ESTADO.columnas].sort((a, b) => a.posicion - b.posicion).map((c) =>
          `<option value="${esc(c.id)}" ${c.id === ficha.columna_id ? 'selected' : ''}>${esc(c.nombre)}</option>`
        ).join('')}
      </select>
    </div>

    <div class="ficha-mover">
      <label for="asignar-select">${esc(tp('tablero.asignado_a'))}</label>
      <select id="asignar-select">
        <option value="">${esc(tp('tablero.sin_asignar'))}</option>
        ${USUARIOS_ASIGNABLES.map((u) =>
          `<option value="${esc(u._id)}" ${ficha.asignado_a?.usuario_id === u._id ? 'selected' : ''}>${esc(u.nombre)}</option>`
        ).join('')}
      </select>
    </div>

    <h3>${esc(tp('tablero.notas_internas'))} <span class="ficha-notas-aviso">${esc(tp('tablero.notas_aviso'))}</span></h3>
    <div class="historial">
      ${(ficha.notas_internas || []).slice().reverse().map((n) => `
        <div class="hist-item">
          <div class="hist-meta">${esc(n.autor)} · ${formatearFecha(n.fecha_hora)}</div>
          <div class="hist-texto">${esc(n.texto)}</div>
        </div>
      `).join('') || `<p>${esc(tp('tablero.sin_notas'))}</p>`}
    </div>
    <div class="ficha-nota-nueva">
      <input id="nota-input" type="text" maxlength="500" placeholder="${esc(tp('tablero.nota_ph'))}">
      <button type="button" class="btn-ghost" id="nota-guardar">${esc(tp('tablero.agregar'))}</button>
    </div>
    <p class="ficha-monto-status" id="nota-status"></p>

    ${/^\+?[\d\s-]{6,20}$/.test(ficha.contacto || '') ? `
      <h3>${esc(tp('tablero.responder_wa'))}</h3>
      ${(Date.now() - new Date(ficha.fecha_hora_ultimo_mensaje || ficha.fecha_hora_recibido).getTime()) > 24 * 60 * 60 * 1000 ? `
        <p class="ficha-notas-aviso" style="margin: -8px 0 10px; display: block;">${esc(tp('tablero.aviso_24hs'))}</p>
      ` : ''}
      <div class="ficha-nota-nueva">
        <input id="responder-input" type="text" maxlength="4096" placeholder="${esc(tp('tablero.mensaje_ph'))}">
        <button type="button" class="btn-ghost" id="responder-enviar">${esc(tp('tablero.enviar'))}</button>
      </div>
      <p class="ficha-monto-status" id="responder-status"></p>
    ` : ''}

    <h3>${esc(tp('tablero.historial'))}</h3>
    <div class="historial">${historial || `<p>${esc(tp('tablero.sin_mensajes'))}</p>`}</div>
  `;

  document.getElementById('monto-guardar').addEventListener('click', () => {
    guardarMonto(fichaId, document.getElementById('monto-input'), document.getElementById('monto-status'));
  });

  document.querySelectorAll('.etiqueta-quitar').forEach((btn) => {
    btn.addEventListener('click', () => {
      const restantes = (ficha.etiquetas || []).filter((e) => e !== btn.dataset.etiqueta);
      guardarEtiquetas(fichaId, restantes);
    });
  });
  document.getElementById('etiqueta-input').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const nueva = e.target.value.trim();
    if (!nueva) return;
    guardarEtiquetas(fichaId, [...(ficha.etiquetas || []), nueva]);
  });

  document.getElementById('nota-guardar').addEventListener('click', () => {
    guardarNota(fichaId, document.getElementById('nota-input'), document.getElementById('nota-status'));
  });
  document.getElementById('nota-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') guardarNota(fichaId, document.getElementById('nota-input'), document.getElementById('nota-status'));
  });

  const btnResponder = document.getElementById('responder-enviar');
  if (btnResponder) {
    btnResponder.addEventListener('click', () => {
      responderWhatsapp(fichaId, document.getElementById('responder-input'), document.getElementById('responder-status'));
    });
    document.getElementById('responder-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') responderWhatsapp(fichaId, document.getElementById('responder-input'), document.getElementById('responder-status'));
    });
  }

  document.getElementById('mover-select').addEventListener('change', async (e) => {
    const nuevaColumnaId = e.target.value;
    if (nuevaColumnaId === ficha.columna_id) return;
    const posicionDestino = ESTADO.fichas.filter((f) => f.columna_id === nuevaColumnaId).length;
    // Importante: la pestaña activa se cambia ANTES de mover la ficha, porque moverFicha()
    // ya vuelve a dibujar el tablero de atrás - si no, queda mostrando la pestaña vieja
    // (de la que la ficha se acaba de ir) y parece que la ficha desapareció.
    columnaActivaMobile = nuevaColumnaId;
    await moverFicha(fichaId, nuevaColumnaId, posicionDestino);
    abrirFicha(fichaId);
  });

  document.getElementById('asignar-select').addEventListener('change', async (e) => {
    try {
      const data = await api(`/api/admin/fichas/${fichaId}/asignar`, {
        method: 'PUT',
        body: JSON.stringify({ usuario_id: e.target.value || null })
      });
      ficha.asignado_a = data.asignado_a;
      renderTablero();
    } catch (err) {
      alert(tp('tablero.error_asignar', { mensaje: err.message }));
    }
  });

  document.getElementById('ficha-overlay').hidden = false;
}

document.getElementById('ficha-close').addEventListener('click', () => {
  document.getElementById('ficha-overlay').hidden = true;
});
document.getElementById('ficha-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'ficha-overlay') document.getElementById('ficha-overlay').hidden = true;
});

async function cerrarSesion() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
document.getElementById('logout-btn').addEventListener('click', cerrarSesion);
document.getElementById('logout-btn-mobile').addEventListener('click', cerrarSesion);

document.getElementById('search-input').addEventListener('input', (e) => {
  filtroBusqueda = e.target.value.trim();
  renderTablero();
});

async function cargarTablero() {
  const data = await api('/api/admin/tablero');
  ESTADO = data;
  renderTablero();
}

// Lista de a quién se le puede asignar una ficha - no cambia seguido, se carga una sola
// vez (no en cada refresh de 20s como ESTADO) para no pedirla de más.
let USUARIOS_ASIGNABLES = [];
async function cargarUsuariosAsignables() {
  try {
    const { usuarios } = await api('/api/admin/usuarios/asignables');
    USUARIOS_ASIGNABLES = usuarios;
  } catch {
    // si falla, el selector de la ficha simplemente queda vacío - no es crítico
  }
}

cargarTablero().catch((err) => {
  document.getElementById('board').innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
});
cargarUsuariosAsignables();

// Actualiza solo, cada 20s, para que aparezcan las fichas nuevas que van llegando por
// WhatsApp o formulario sin tener que recargar la página a mano.
setInterval(() => cargarTablero().catch(() => {}), 20000);

// ---------- Empleados (solo lo ve y usa Gerencia) ----------
async function abrirEmpleados() {
  document.getElementById('empleados-overlay').hidden = false;
  document.getElementById('empleado-status').textContent = '';
  document.getElementById('empleado-nuevo-form').reset();
  try {
    const [{ usuarios }, { departamentos }] = await Promise.all([
      api('/api/admin/usuarios'),
      api('/api/admin/departamentos')
    ]);
    renderEmpleados(usuarios);
    const select = document.getElementById('emp-departamento');
    select.innerHTML = departamentos.length
      ? departamentos.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')
      : `<option value="" disabled selected>${esc(tp('tablero.emp_sin_departamentos'))}</option>`;
  } catch (err) {
    document.getElementById('empleados-lista').innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
}

function renderEmpleados(usuarios) {
  const cont = document.getElementById('empleados-lista');
  const empleados = usuarios.filter((u) => u.rol === 'departamento');
  if (empleados.length === 0) {
    cont.innerHTML = `<p class="loading" style="padding: 0;">${esc(tp('tablero.emp_ninguno'))}</p>`;
    return;
  }
  cont.innerHTML = empleados.map((u) => `
    <div class="sa-columna-fila">
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 13px;">${esc(u.nombre)} <span style="color: var(--text-muted);">· ${esc(u.usuario)}</span></div>
        <div style="font-size: 11.5px; color: var(--text-muted);">${esc(u.departamento)}</div>
      </div>
      <button type="button" class="btn-ghost sa-columna-borrar" data-borrar-empleado="${u._id}"><i class="fa-solid fa-trash"></i></button>
    </div>
  `).join('');
  cont.querySelectorAll('[data-borrar-empleado]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(tp('tablero.emp_confirmar_borrar'))) return;
      try {
        await api(`/api/admin/usuarios/${btn.dataset.borrarEmpleado}`, { method: 'DELETE' });
        abrirEmpleados();
      } catch (err) {
        document.getElementById('empleado-status').textContent = err.message;
      }
    });
  });
}

document.getElementById('nav-empleados').addEventListener('click', abrirEmpleados);
document.getElementById('aviso-lead-checkbox').addEventListener('change', async (e) => {
  try {
    await api('/api/admin/preferencias', {
      method: 'PUT',
      body: JSON.stringify({ avisos_lead_email: e.target.checked })
    });
  } catch {
    e.target.checked = !e.target.checked; // si falló, volvemos el checkbox a como estaba
  }
});
document.getElementById('resumen-semanal-checkbox').addEventListener('change', async (e) => {
  try {
    await api('/api/admin/preferencias', {
      method: 'PUT',
      body: JSON.stringify({ resumen_semanal_email: e.target.checked })
    });
  } catch {
    e.target.checked = !e.target.checked;
  }
});

document.getElementById('btn-copiar-enlace').addEventListener('click', async () => {
  const link = `${location.origin}/enlace.html?slug=${encodeURIComponent(ESTADO.cliente?.slug || '')}`;
  const btn = document.getElementById('btn-copiar-enlace');
  try {
    await navigator.clipboard.writeText(link);
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(tp('tablero.copiado'))}`;
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch {
    prompt(tp('tablero.copia_este_link'), link);
  }
});

document.getElementById('btn-config-general').addEventListener('click', () => {
  document.getElementById('config-general-overlay').hidden = false;
  document.getElementById('config-general-status').textContent = '';
  document.getElementById('config-review-link').value = ESTADO.cliente?.google_review_link || '';
  document.getElementById('config-idioma').value = PanelI18n.idioma;

  const usoDiv = document.getElementById('config-uso-whatsapp');
  const tienePlan = Boolean(ESTADO.cliente?.plan);
  if (tienePlan) {
    const usados = ESTADO.cliente?.turnos_mensajes_usados_mes || 0;
    // El costo en pesos solo tiene sentido para negocios argentinos (español) - Meta cobra
    // en la moneda de la cuenta de cada negocio, y la tarifa varía según el país, así que
    // en inglés/portugués se explica el cobro sin inventar una cifra.
    const PRECIO_UTILITY_ARS = 37.68;
    const gastoEstimado = (usados * PRECIO_UTILITY_ARS).toLocaleString(PanelI18n.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    usoDiv.hidden = false;
    usoDiv.innerHTML = `
      <strong>${esc(tp('tablero.uso_wa_titulo'))}</strong> ${tpn('tablero.uso_wa_enviados', usados)}
      <p style="margin: 6px 0 0;">${tp('tablero.uso_wa_detalle', { gasto: gastoEstimado })}</p>
      <p style="margin: 6px 0 0;">${tp('tablero.uso_wa_tarjeta')}</p>
    `;
  } else {
    usoDiv.hidden = true;
  }

  const audioDiv = document.getElementById('config-uso-audio');
  const limiteAudio = ESTADO.cliente?.audios_limite_mes;
  if (limiteAudio != null) {
    const usadosAudio = ESTADO.cliente?.audios_usados_mes || 0;
    audioDiv.hidden = false;
    audioDiv.innerHTML = `
      <strong>${esc(tp('tablero.uso_audio_titulo'))}</strong> ${esc(tp('tablero.uso_audio_conteo', { usados: usadosAudio, limite: limiteAudio }))}
      <p style="margin: 6px 0 0;">${esc(tp('tablero.uso_audio_detalle'))}</p>
    `;
  } else {
    audioDiv.hidden = true;
  }
});
document.getElementById('config-general-close').addEventListener('click', () => {
  document.getElementById('config-general-overlay').hidden = true;
});
document.getElementById('config-general-guardar').addEventListener('click', async () => {
  const status = document.getElementById('config-general-status');
  status.textContent = tp('comun.guardando');
  status.className = 'form-status';
  try {
    const nuevoIdioma = document.getElementById('config-idioma').value;
    await api('/api/admin/preferencias', {
      method: 'PUT',
      body: JSON.stringify({
        google_review_link: document.getElementById('config-review-link').value.trim(),
        idioma: nuevoIdioma
      })
    });
    if (ESTADO.cliente) ESTADO.cliente.google_review_link = document.getElementById('config-review-link').value.trim();
    status.textContent = tp('comun.guardado');
    if (nuevoIdioma !== PanelI18n.idioma) {
      // El servidor ya actualizó la cookie - recargar para que todo el panel salga en el idioma nuevo.
      setTimeout(() => window.location.reload(), 500);
      return;
    }
    setTimeout(() => { document.getElementById('config-general-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

document.getElementById('empleados-close').addEventListener('click', () => {
  document.getElementById('empleados-overlay').hidden = true;
});
document.getElementById('empleado-nuevo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('empleado-status');
  status.textContent = tp('tablero.emp_agregando');
  status.className = 'form-status';
  try {
    await api('/api/admin/usuarios', {
      method: 'POST',
      body: JSON.stringify({
        nombre: document.getElementById('emp-nombre').value.trim(),
        usuario: document.getElementById('emp-usuario').value.trim(),
        password: document.getElementById('emp-password').value,
        departamento: document.getElementById('emp-departamento').value
      })
    });
    status.textContent = tp('tablero.emp_agregado');
    document.getElementById('empleado-nuevo-form').reset();
    const { usuarios } = await api('/api/admin/usuarios');
    renderEmpleados(usuarios);
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Notificaciones push (PWA) ----------
// Aviso al instante de leads nuevos, además del email - opt-in por persona (cada quien
// activa o no en su propio celular/navegador), respeta el mismo filtro por departamento
// que el resto del tablero (server/routes/webhooks.js).
function base64UrlAUint8Array(base64Url) {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function actualizarBotonPush() {
  const boton = document.getElementById('push-btn');
  const texto = document.getElementById('push-btn-texto');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    boton.hidden = true;
    return;
  }
  const registro = await navigator.serviceWorker.ready;
  const suscripcion = await registro.pushManager.getSubscription();
  texto.textContent = suscripcion ? tp('tablero.push_desactivar') : tp('tablero.push_activar');
  boton.dataset.suscrito = suscripcion ? 'si' : 'no';
}

async function alternarPush() {
  const boton = document.getElementById('push-btn');
  const registro = await navigator.serviceWorker.ready;
  const suscripcionActual = await registro.pushManager.getSubscription();

  if (suscripcionActual) {
    await api('/api/admin/push/suscribir', { method: 'DELETE', body: JSON.stringify({ endpoint: suscripcionActual.endpoint }) });
    await suscripcionActual.unsubscribe();
    await actualizarBotonPush();
    return;
  }

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return;

  const { publicKey } = await api('/api/admin/push/public-key');
  const nuevaSuscripcion = await registro.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlAUint8Array(publicKey)
  });
  await api('/api/admin/push/suscribir', { method: 'POST', body: JSON.stringify(nuevaSuscripcion.toJSON()) });
  await actualizarBotonPush();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => actualizarBotonPush()).catch(() => {
    document.getElementById('push-btn').hidden = true;
  });
} else {
  document.getElementById('push-btn').hidden = true;
}
document.getElementById('push-btn').addEventListener('click', alternarPush);

// ---------- Botón "Instalar la app" ----------
// Sin esto, instalar la PWA depende de que alguien encuentre la opción escondida en el
// menú del navegador - casi nadie la busca. Chrome/Android avisan con este evento cuando
// la página ya es instalable, y ahí mostramos nuestro propio botón bien visible en vez de
// esperar a que lo encuentren solos. En iPhone (Safari) este evento no existe - ahí se
// muestran instrucciones en vez de un botón, porque Safari no deja disparar la instalación
// por código, solo a mano desde "Compartir".
let promptDeInstalacion = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptDeInstalacion = e;
  document.getElementById('instalar-btn').hidden = false;
});
document.getElementById('instalar-btn').addEventListener('click', async () => {
  if (!promptDeInstalacion) return;
  promptDeInstalacion.prompt();
  await promptDeInstalacion.userChoice;
  promptDeInstalacion = null;
  document.getElementById('instalar-btn').hidden = true;
});
window.addEventListener('appinstalled', () => {
  document.getElementById('instalar-btn').hidden = true;
});

const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const yaInstalada = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
if (esIOS && !yaInstalada) {
  // En iPhone no existe "beforeinstallprompt" - Safari no deja disparar la instalación por
  // código, así que acá solo se puede mostrar la instrucción, no un botón que instale solo.
  const boton = document.getElementById('instalar-btn');
  boton.hidden = false;
  boton.innerHTML = `<i class="fa-solid fa-download"></i> ${esc(tp('tablero.instalar_ios'))}`;
}

// ---------- Importar contactos desde CSV ----------
// Parser simple pero correcto para CSV (RFC4180): soporta campos entre comillas con comas
// y saltos de línea adentro, y comillas escapadas como "". Cualquier sistema (Excel,
// Google Sheets, otro CRM) exporta en este formato o algo compatible con esto.
function parsearCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else { entreComillas = false; }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      fila.push(campo); campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.length > 1 || fila[0] !== '') filas.push(fila);
      fila = [];
    } else {
      campo += c;
    }
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

const CAMPOS_IMPORTAR = [
  { campo: 'nombre', clave: 'tablero.imp_campo_nombre', requerido: true },
  { campo: 'contacto', clave: 'tablero.imp_campo_contacto', requerido: true },
  { campo: 'etapa', clave: 'tablero.imp_campo_etapa', requerido: false },
  { campo: 'monto', clave: 'tablero.imp_campo_monto', requerido: false },
  { campo: 'etiquetas', clave: 'tablero.imp_campo_etiquetas', requerido: false }
];

let importarDatos = null; // { encabezados, filas }

function adivinarColumna(encabezados, posibles) {
  const idx = encabezados.findIndex((h) => posibles.includes(h.trim().toLowerCase()));
  return idx === -1 ? '' : String(idx);
}

function mostrarMapeoImportar() {
  const { encabezados, filas } = importarDatos;
  document.getElementById('importar-resumen').textContent = tpn('tablero.imp_resumen', filas.length);

  // Nombres de encabezado habituales en los 3 idiomas para adivinar qué columna es cada dato.
  const adivinanzas = {
    nombre: adivinarColumna(encabezados, ['nombre', 'name', 'cliente', 'customer', 'nome']),
    contacto: adivinarColumna(encabezados, ['contacto', 'telefono', 'teléfono', 'phone', 'celular', 'whatsapp', 'email', 'mail', 'correo', 'contact', 'telefone', 'e-mail']),
    etapa: adivinarColumna(encabezados, ['etapa', 'columna', 'estado', 'stage', 'status', 'estágio', 'estagio']),
    monto: adivinarColumna(encabezados, ['monto', 'valor', 'importe', 'amount', 'value', 'montante']),
    etiquetas: adivinarColumna(encabezados, ['etiquetas', 'tags', 'etiqueta'])
  };

  document.getElementById('importar-mapeo').innerHTML = CAMPOS_IMPORTAR.map(({ campo, clave, requerido }) => `
    <div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px;">
        ${esc(tp(clave))}${requerido ? '' : esc(tp('tablero.imp_opcional'))}
      </label>
      <select id="map-${campo}" style="width: 100%; padding: 9px 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 9px; color: var(--text-primary); font-size: 0.85rem;">
        ${requerido ? '' : `<option value="">${esc(tp('tablero.imp_ninguna'))}</option>`}
        ${encabezados.map((h, i) => `<option value="${i}" ${String(i) === adivinanzas[campo] ? 'selected' : ''}>${esc(h)}</option>`).join('')}
      </select>
    </div>
  `).join('');
}

document.getElementById('btn-importar-csv').addEventListener('click', () => {
  document.getElementById('importar-csv-input').click();
});

document.getElementById('importar-csv-input').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  e.target.value = ''; // para poder reelegir el mismo archivo si hace falta reintentar
  if (!archivo) return;

  const texto = await archivo.text();
  const filasCrudas = parsearCSV(texto).filter((f) => f.some((c) => c.trim() !== ''));
  if (filasCrudas.length < 2) {
    alert(tp('tablero.imp_sin_filas'));
    return;
  }

  importarDatos = { encabezados: filasCrudas[0], filas: filasCrudas.slice(1) };
  mostrarMapeoImportar();
  document.getElementById('importar-status').textContent = '';
  document.getElementById('importar-overlay').hidden = false;
});

document.getElementById('importar-close').addEventListener('click', () => {
  document.getElementById('importar-overlay').hidden = true;
});

document.getElementById('importar-confirmar').addEventListener('click', async () => {
  const status = document.getElementById('importar-status');
  const idxNombre = parseInt(document.getElementById('map-nombre').value, 10);
  const idxContacto = parseInt(document.getElementById('map-contacto').value, 10);
  const idxEtapa = document.getElementById('map-etapa').value;
  const idxMonto = document.getElementById('map-monto').value;
  const idxEtiquetas = document.getElementById('map-etiquetas').value;

  if (Number.isNaN(idxContacto)) {
    status.textContent = tp('tablero.imp_elegi_contacto');
    status.className = 'form-status error';
    return;
  }

  const filas = importarDatos.filas.map((f) => ({
    nombre: Number.isNaN(idxNombre) ? '' : (f[idxNombre] || '').trim(),
    contacto: (f[idxContacto] || '').trim(),
    etapa: idxEtapa !== '' ? (f[parseInt(idxEtapa, 10)] || '').trim() : '',
    monto: idxMonto !== '' ? (f[parseInt(idxMonto, 10)] || '').trim() : '',
    etiquetas: idxEtiquetas !== '' ? (f[parseInt(idxEtiquetas, 10)] || '').trim() : ''
  }));

  status.textContent = tp('tablero.imp_importando');
  status.className = 'form-status';
  try {
    const resultado = await api('/api/admin/fichas/importar', { method: 'POST', body: JSON.stringify({ filas }) });
    status.textContent = tp('tablero.imp_listo', {
      creados: tpn('tablero.imp_creados', resultado.creados),
      duplicados: tpn('tablero.imp_duplicados', resultado.duplicados),
      invalidos: resultado.invalidos
    });
    status.className = 'form-status ok';
    await cargarTablero();
    setTimeout(() => { document.getElementById('importar-overlay').hidden = true; }, 2200);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Mensajes por etiqueta (envío masivo) ----------
let ETIQUETAS_DISPONIBLES = [];

async function abrirMensajesMasivos() {
  document.getElementById('mensajes-masivos-overlay').hidden = false;
  document.getElementById('mm-status').textContent = '';
  document.getElementById('mm-texto').value = '';
  const select = document.getElementById('mm-etiqueta');
  const conteo = document.getElementById('mm-conteo');
  select.innerHTML = `<option>${esc(tp('comun.cargando'))}</option>`;
  conteo.textContent = '';
  try {
    const { etiquetas } = await api('/api/admin/etiquetas');
    ETIQUETAS_DISPONIBLES = etiquetas;
    if (!etiquetas.length) {
      select.innerHTML = `<option value="">${esc(tp('tablero.mm_sin_etiquetas'))}</option>`;
      return;
    }
    select.innerHTML = etiquetas.map((e) => `<option value="${esc(e.etiqueta)}">${esc(e.etiqueta)} (${e.cantidad})</option>`).join('');
    actualizarConteoMensajesMasivos();
  } catch (err) {
    select.innerHTML = `<option value="">${esc(tp('tablero.mm_error_etiquetas'))}</option>`;
  }
}

function actualizarConteoMensajesMasivos() {
  const etiqueta = document.getElementById('mm-etiqueta').value;
  const info = ETIQUETAS_DISPONIBLES.find((e) => e.etiqueta === etiqueta);
  const conteo = document.getElementById('mm-conteo');
  if (!info) { conteo.textContent = ''; return; }
  const costoEstimado = (info.cantidad_whatsapp * 37.68).toLocaleString(PanelI18n.locale, { maximumFractionDigits: 0 });
  conteo.textContent = tp('tablero.mm_conteo', {
    contactos: tpn('tablero.mm_contactos', info.cantidad, { whatsapp: info.cantidad_whatsapp }),
    costo: costoEstimado
  });
}

document.getElementById('btn-mensajes-masivos').addEventListener('click', abrirMensajesMasivos);
document.getElementById('mensajes-masivos-close').addEventListener('click', () => {
  document.getElementById('mensajes-masivos-overlay').hidden = true;
});
document.getElementById('mm-etiqueta').addEventListener('change', actualizarConteoMensajesMasivos);

document.getElementById('mm-enviar').addEventListener('click', async () => {
  const status = document.getElementById('mm-status');
  const etiqueta = document.getElementById('mm-etiqueta').value;
  const texto = document.getElementById('mm-texto').value.trim();
  if (!etiqueta) { status.textContent = tp('tablero.mm_elegi_etiqueta'); status.className = 'form-status error'; return; }
  if (!texto) { status.textContent = tp('tablero.mm_escribi_mensaje'); status.className = 'form-status error'; return; }
  if (!confirm(tp('tablero.mm_confirmar', { etiqueta }))) return;

  status.textContent = tp('tablero.mm_mandando');
  status.className = 'form-status';
  try {
    const r = await api('/api/admin/mensajes-masivos', { method: 'POST', body: JSON.stringify({ etiqueta, texto }) });
    status.textContent = tp('tablero.mm_listo', {
      enviados: tpn('tablero.mm_enviados', r.enviados),
      plantilla: r.viaPlantilla,
      fallidos: r.fallidos,
      sinWhatsapp: r.sinWhatsapp,
      costo: r.costoEstimado.toLocaleString(PanelI18n.locale)
    });
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});
