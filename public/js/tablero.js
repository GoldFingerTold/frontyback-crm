// Tablero Kanban: arma las columnas y las fichas a partir de /api/admin/tablero, y deja
// arrastrar las fichas entre columnas (drag-and-drop nativo del navegador, sin librerías).

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
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ORIGEN_INFO = {
  formulario: { icon: 'fa-regular fa-envelope', label: 'Formulario' },
  whatsapp_texto: { icon: 'fa-brands fa-whatsapp', label: 'WhatsApp' },
  whatsapp_audio: { icon: 'fa-solid fa-microphone', label: 'WhatsApp audio' },
  importado: { icon: 'fa-solid fa-file-csv', label: 'Importado' },
  meta_ads: { icon: 'fa-brands fa-meta', label: 'Meta Ads' }
};

function origenInfo(origen) {
  return ORIGEN_INFO[origen] || { icon: 'fa-solid fa-message', label: origen || '' };
}

function formatearFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatearMonto(monto) {
  if (monto === null || monto === undefined || monto === '') return null;
  return '$ ' + Math.round(Number(monto)).toLocaleString('es-AR');
}

function esColumnaGanada(nombreColumna) {
  return /concretad|ganad|vend/i.test(nombreColumna || '');
}

function esColumnaPerdida(nombreColumna) {
  return /perdid|no avanz|descart|cancel/i.test(nombreColumna || '');
}

// Una ficha se considera "fría" si hace más de DIAS_FRIO días que no hay ningún mensaje
// nuevo del cliente, Y todavía está en una etapa activa (no se cuenta una venta ya
// concretada o ya descartada, ahí no hay nada que "seguir"). Es solo un aviso visual para
// el equipo - no manda ningún mensaje solo, eso sería proactivo y tendría costo/sería spam.
const DIAS_FRIO = 5;

function fichaEstaFria(ficha, columna) {
  if (!columna || esColumnaGanada(columna.nombre) || esColumnaPerdida(columna.nombre)) return false;
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
      ${fria ? `<span class="card-frio-badge" title="Sin novedades hace más de ${DIAS_FRIO} días"><i class="fa-solid fa-snowflake"></i></span>` : ''}
    </div>
    <div class="card-body">"${esc((ficha.ultimo_mensaje || ficha.mensaje || '').slice(0, 100))}"</div>
    ${(ficha.etiquetas || []).length ? `<div class="card-etiquetas">${(ficha.etiquetas || []).map((e) => `<span class="etiqueta-chip">${esc(e)}</span>`).join('')}</div>` : ''}
    ${ficha.asignado_a ? `<div class="card-asignado"><i class="fa-regular fa-user"></i> ${esc(ficha.asignado_a.nombre)}</div>` : ''}
    <div class="card-divider"></div>
    <div class="card-footer">
      ${montoTexto ? `<span class="card-value">${montoTexto}</span>` : `<span class="card-value sin-monto">Sin monto</span>`}
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

    const badgeClase = esColumnaGanada(columna.nombre) ? 'column-count' : 'column-count';
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
        ? '<div class="cards-empty">Sin resultados acá</div>'
        : '<div class="cards-empty">Sin fichas por ahora</div>';
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

function actualizarCabecera() {
  if (ESTADO.cliente) {
    document.getElementById('user-nombre').textContent = ESTADO.cliente.nombre || '';
    document.getElementById('user-slug').textContent = ESTADO.cliente.slug || '';
    const iniciales = (ESTADO.cliente.nombre || '?')
      .split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    document.getElementById('user-avatar').textContent = iniciales || '?';
  }

  if (ESTADO.usuario) {
    const esGerencia = ESTADO.usuario.rol === 'gerencia';
    document.getElementById('user-rol').textContent = esGerencia
      ? 'Gerencia · ve todo'
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
  document.getElementById('metrics-nuevas-hoy').textContent = `+${nuevasHoy} nuevas hoy`;

  const columnasPorId = Object.fromEntries(ESTADO.columnas.map((c) => [c.id, c]));
  const frias = ESTADO.fichas.filter((f) => fichaEstaFria(f, columnasPorId[f.columna_id])).length;
  document.getElementById('metrics-frias').hidden = frias === 0;
  document.getElementById('metrics-frias-texto').textContent = `${frias} sin avance`;

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
      <span>Tu plan venció y dejamos de mandar respuestas automáticas. <strong>Te quedan ${dias} día${dias === 1 ? '' : 's'}</strong> para reactivarlo antes de que se corte el servicio del todo.</span>
      <button type="button" class="btn-reactivar" id="btn-reactivar">Reactivar ahora</button>
    `;
    banner.hidden = false;
    document.getElementById('btn-reactivar').addEventListener('click', abrirLinkDePago);
  } else if (estado === 'vencido_cortado') {
    banner.className = 'estado-banner cortado';
    banner.innerHTML = `
      <span>Tu servicio está cortado por falta de pago - no se están guardando consultas nuevas. Mirá todo lo que te estás perdiendo y <strong>reactivalo cuando quieras</strong>, tus datos siguen intactos.</span>
      <button type="button" class="btn-reactivar" id="btn-reactivar">Reactivar ahora</button>
    `;
    banner.hidden = false;
    document.getElementById('btn-reactivar').addEventListener('click', abrirLinkDePago);
  } else if (ESTADO.cliente?.whatsapp_pago_pendiente) {
    banner.className = 'estado-banner pago-pendiente';
    banner.innerHTML = `
      <span>No se están enviando tus recordatorios de turno por WhatsApp: Meta requiere un método de pago cargado en tu cuenta de Meta Business para procesar estos envíos, y todavía no lo configuraste. <strong>Los turnos se siguen reservando con normalidad</strong>, solo no se envía el mensaje.</span>
      <button type="button" class="btn-reactivar" id="btn-ayuda-pago-whatsapp">¿Cómo lo soluciono?</button>
    `;
    banner.hidden = false;
    const detalle = document.getElementById('pago-pendiente-detalle');
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
  boton.textContent = 'Generando link...';
  boton.disabled = true;
  try {
    const res = await fetch('/api/admin/pago/link', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.link) throw new Error(data.error || 'No se pudo generar el link de pago.');
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
    alert('No se pudo guardar el movimiento: ' + err.message);
    await cargarTablero();
  }
}

async function guardarMonto(fichaId, valorInput, statusEl) {
  const crudo = valorInput.value.trim();
  statusEl.textContent = 'Guardando...';
  try {
    const data = await api(`/api/admin/fichas/${fichaId}/monto`, {
      method: 'PUT',
      body: JSON.stringify({ monto: crudo === '' ? null : crudo })
    });
    const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
    if (ficha) ficha.monto = data.monto;
    statusEl.textContent = 'Guardado.';
    renderTablero();
    setTimeout(() => { statusEl.textContent = ''; }, 1800);
  } catch (err) {
    statusEl.textContent = 'No se pudo guardar: ' + err.message;
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
  statusEl.textContent = 'Guardando...';
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
    statusEl.textContent = 'No se pudo guardar: ' + err.message;
  }
}

async function responderWhatsapp(fichaId, textoInput, statusEl) {
  const texto = textoInput.value.trim();
  if (!texto) return;
  statusEl.textContent = 'Enviando...';
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
      statusEl.textContent = 'Enviado como plantilla con costo (≈ $37,68 ARS) - habían pasado más de 24hs.';
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
  const badgeClase = columna && esColumnaGanada(columna.nombre) ? 'card-status-badge success' : 'card-status-badge';

  const historial = (ficha.historial || [])
    .slice()
    .reverse()
    .map((h) => {
      const info = origenInfo(h.origen || h.canal);
      return `
      <div class="hist-item hist-${h.tipo}">
        <div class="hist-meta">${h.tipo === 'respuesta_saliente' ? 'Respondimos' : 'Escribió'} · ${esc(info.label)} · ${formatearFecha(h.fecha_hora)}</div>
        <div class="hist-texto">${esc(h.contenido)}</div>
      </div>
    `;
    }).join('');

  document.getElementById('ficha-body').innerHTML = `
    <h2>${esc(ficha.nombre || '(sin nombre)')}</h2>
    <p class="ficha-contacto">${esc(ficha.contacto)}</p>
    <p class="ficha-meta">
      <span>Recibido: ${formatearFecha(ficha.fecha_hora_recibido)}</span>
      ${columna ? `<span class="${badgeClase}">${esc(columna.nombre)}</span>` : ''}
    </p>

    <div class="ficha-etiquetas">
      ${(ficha.etiquetas || []).map((e) => `<span class="etiqueta-chip">${esc(e)}<button type="button" class="etiqueta-quitar" data-etiqueta="${esc(e)}">&times;</button></span>`).join('')}
      <input id="etiqueta-input" type="text" maxlength="30" placeholder="+ etiqueta">
    </div>

    ${columna && esColumnaGanada(columna.nombre) && ESTADO.cliente?.google_review_link && /^\+?[\d\s-]{6,20}$/.test(ficha.contacto || '') ? `
      <a class="btn-ghost" id="btn-pedir-resena" style="display: block; text-align: center; margin: 10px 0; text-decoration: none; color: #2bb673; border-color: rgba(43,182,115,0.3);" target="_blank" rel="noopener"
         href="https://wa.me/${esc((ficha.contacto || '').replace(/\D/g, ''))}?text=${encodeURIComponent(`¡Hola ${ficha.nombre || ''}! Gracias por confiar en nosotros. Si te gustó, ¿nos dejás una reseña? ${ESTADO.cliente.google_review_link}`)}">
        <i class="fa-brands fa-google"></i> Pedir reseña por WhatsApp
      </a>
    ` : ''}

    <div class="ficha-monto">
      <div>
        <label for="monto-input">Valor del negocio</label>
        <input id="monto-input" type="number" min="0" step="1" placeholder="Sin cargar" value="${ficha.monto ?? ''}">
      </div>
      <button type="button" class="btn-ghost" id="monto-guardar">Guardar</button>
    </div>
    <p class="ficha-monto-status" id="monto-status"></p>

    <div class="ficha-mover">
      <label for="mover-select">Etapa</label>
      <select id="mover-select">
        ${[...ESTADO.columnas].sort((a, b) => a.posicion - b.posicion).map((c) =>
          `<option value="${esc(c.id)}" ${c.id === ficha.columna_id ? 'selected' : ''}>${esc(c.nombre)}</option>`
        ).join('')}
      </select>
    </div>

    <div class="ficha-mover">
      <label for="asignar-select">Asignado a</label>
      <select id="asignar-select">
        <option value="">Sin asignar</option>
        ${USUARIOS_ASIGNABLES.map((u) =>
          `<option value="${esc(u._id)}" ${ficha.asignado_a?.usuario_id === u._id ? 'selected' : ''}>${esc(u.nombre)}</option>`
        ).join('')}
      </select>
    </div>

    <h3>Notas internas <span class="ficha-notas-aviso">(el cliente no las ve)</span></h3>
    <div class="historial">
      ${(ficha.notas_internas || []).slice().reverse().map((n) => `
        <div class="hist-item">
          <div class="hist-meta">${esc(n.autor)} · ${formatearFecha(n.fecha_hora)}</div>
          <div class="hist-texto">${esc(n.texto)}</div>
        </div>
      `).join('') || '<p>Sin notas todavía.</p>'}
    </div>
    <div class="ficha-nota-nueva">
      <input id="nota-input" type="text" maxlength="500" placeholder="Escribir una nota para el equipo...">
      <button type="button" class="btn-ghost" id="nota-guardar">Agregar</button>
    </div>
    <p class="ficha-monto-status" id="nota-status"></p>

    ${/^\+?[\d\s-]{6,20}$/.test(ficha.contacto || '') ? `
      <h3>Responder por WhatsApp</h3>
      ${(Date.now() - new Date(ficha.fecha_hora_ultimo_mensaje || ficha.fecha_hora_recibido).getTime()) > 24 * 60 * 60 * 1000 ? `
        <p class="ficha-notas-aviso" style="margin: -8px 0 10px; display: block;">Pasaron más de 24hs desde el último mensaje del cliente - este mensaje se manda igual, pero como plantilla con costo real (≈ $37,68 ARS, a cargo de la tarjeta cargada en tu cuenta de Meta Business).</p>
      ` : ''}
      <div class="ficha-nota-nueva">
        <input id="responder-input" type="text" maxlength="4096" placeholder="Escribir un mensaje...">
        <button type="button" class="btn-ghost" id="responder-enviar">Enviar</button>
      </div>
      <p class="ficha-monto-status" id="responder-status"></p>
    ` : ''}

    <h3>Historial</h3>
    <div class="historial">${historial || '<p>Sin mensajes todavía.</p>'}</div>
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
      alert('No se pudo asignar: ' + err.message);
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
  document.getElementById('board').innerHTML = `<p class="loading">Error: ${err.message}</p>`;
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
      : '<option value="" disabled selected>No hay departamentos todavía</option>';
  } catch (err) {
    document.getElementById('empleados-lista').innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

function renderEmpleados(usuarios) {
  const cont = document.getElementById('empleados-lista');
  const empleados = usuarios.filter((u) => u.rol === 'departamento');
  if (empleados.length === 0) {
    cont.innerHTML = '<p class="loading" style="padding: 0;">Todavía no agregaste ningún empleado.</p>';
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
      if (!confirm('¿Borrar a este empleado? Deja de poder entrar al CRM.')) return;
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
    btn.innerHTML = '<i class="fa-solid fa-check"></i> ¡Copiado!';
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch {
    prompt('Copiá este link:', link);
  }
});

document.getElementById('btn-config-general').addEventListener('click', () => {
  document.getElementById('config-general-overlay').hidden = false;
  document.getElementById('config-general-status').textContent = '';
  document.getElementById('config-review-link').value = ESTADO.cliente?.google_review_link || '';

  const usoDiv = document.getElementById('config-uso-whatsapp');
  const tienePlan = Boolean(ESTADO.cliente?.plan);
  if (tienePlan) {
    const usados = ESTADO.cliente?.turnos_mensajes_usados_mes || 0;
    const PRECIO_UTILITY_ARS = 37.68;
    const gastoEstimado = (usados * PRECIO_UTILITY_ARS).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    usoDiv.hidden = false;
    usoDiv.innerHTML = `
      <strong>Recordatorios de turno por WhatsApp este mes:</strong> ${usados} mensaje${usados === 1 ? '' : 's'} enviado${usados === 1 ? '' : 's'}.
      <p style="margin: 6px 0 0;">Meta cobra por los mensajes de WhatsApp enviados por fuera de las 24 horas posteriores al último mensaje de un cliente. La confirmación y el recordatorio de turno aplican a esa tarifa, de ≈ $37,68 ARS (USD 0,026) por mensaje, a cargo de la tarjeta que cargaste en tu cuenta de Meta Business. Gasto estimado este mes: <strong>≈ $${gastoEstimado} ARS</strong>.</p>
      <p style="margin: 6px 0 0;">Si todavía no cargaste una tarjeta ahí, el envío no se concreta y el turno se sigue reservando igual - para cargarla: business.facebook.com/settings → Cuentas → Cuentas de mensajes → la que tiene tu número → Configuración de pagos.</p>
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
      <strong>Audios de WhatsApp (transcripción + respuesta con voz):</strong> ${usadosAudio} / ${limiteAudio} incluidos este mes.
      <p style="margin: 6px 0 0;">Superado ese número, los audios se siguen recibiendo y guardando igual, solo que sin transcribir ni responder con voz hasta el mes siguiente.</p>
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
  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/admin/preferencias', {
      method: 'PUT',
      body: JSON.stringify({ google_review_link: document.getElementById('config-review-link').value.trim() })
    });
    if (ESTADO.cliente) ESTADO.cliente.google_review_link = document.getElementById('config-review-link').value.trim();
    status.textContent = 'Guardado.';
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
  status.textContent = 'Agregando...';
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
    status.textContent = 'Empleado agregado.';
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
  texto.textContent = suscripcion ? 'Desactivar notificaciones' : 'Activar notificaciones';
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
  boton.innerHTML = '<i class="fa-solid fa-download"></i> Instalar: tocá Compartir y "Agregar a inicio"';
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
  { campo: 'nombre', label: 'Nombre', requerido: true },
  { campo: 'contacto', label: 'Contacto (teléfono o email)', requerido: true },
  { campo: 'etapa', label: 'Etapa', requerido: false },
  { campo: 'monto', label: 'Monto', requerido: false },
  { campo: 'etiquetas', label: 'Etiquetas', requerido: false }
];

let importarDatos = null; // { encabezados, filas }

function adivinarColumna(encabezados, posibles) {
  const idx = encabezados.findIndex((h) => posibles.includes(h.trim().toLowerCase()));
  return idx === -1 ? '' : String(idx);
}

function mostrarMapeoImportar() {
  const { encabezados, filas } = importarDatos;
  document.getElementById('importar-resumen').textContent =
    `Encontramos ${filas.length} fila${filas.length === 1 ? '' : 's'} en el archivo. Decinos qué columna es cada dato:`;

  const adivinanzas = {
    nombre: adivinarColumna(encabezados, ['nombre', 'name', 'cliente']),
    contacto: adivinarColumna(encabezados, ['contacto', 'telefono', 'teléfono', 'phone', 'celular', 'whatsapp', 'email', 'mail', 'correo']),
    etapa: adivinarColumna(encabezados, ['etapa', 'columna', 'estado', 'stage']),
    monto: adivinarColumna(encabezados, ['monto', 'valor', 'importe']),
    etiquetas: adivinarColumna(encabezados, ['etiquetas', 'tags'])
  };

  document.getElementById('importar-mapeo').innerHTML = CAMPOS_IMPORTAR.map(({ campo, label, requerido }) => `
    <div style="margin-bottom: 12px;">
      <label style="display: block; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px;">
        ${esc(label)}${requerido ? '' : ' (opcional)'}
      </label>
      <select id="map-${campo}" style="width: 100%; padding: 9px 12px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 9px; color: var(--text-primary); font-size: 0.85rem;">
        ${requerido ? '' : '<option value="">(ninguna)</option>'}
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
    alert('El archivo no tiene filas de datos (solo encabezado, o está vacío).');
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
    status.textContent = 'Elegí al menos la columna de contacto.';
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

  status.textContent = 'Importando...';
  status.className = 'form-status';
  try {
    const resultado = await api('/api/admin/fichas/importar', { method: 'POST', body: JSON.stringify({ filas }) });
    status.textContent = `Listo: ${resultado.creados} importado${resultado.creados === 1 ? '' : 's'}, ${resultado.duplicados} ya existía${resultado.duplicados === 1 ? '' : 'n'}, ${resultado.invalidos} sin datos válidos.`;
    status.className = 'form-status ok';
    await cargarTablero();
    setTimeout(() => { document.getElementById('importar-overlay').hidden = true; }, 2200);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});
