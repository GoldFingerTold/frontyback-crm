// Estadísticas (exclusivo del plan Premium): 4 gráficos armados con datos que ya se
// guardan solos (columna, monto, origen, departamento) - nada de esto le pide carga
// manual extra al cliente.

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

function formatearARS(n) {
  return '$' + Math.round(n || 0).toLocaleString('es-AR');
}
function formatearNumero(n) {
  return Math.round(n || 0).toLocaleString('es-AR');
}

// ---------- Paleta (validada con scripts/validate_palette.js contra el fondo oscuro del CRM) ----------
// Rampa dorada (una sola tonalidad, clara->oscura) para el embudo por etapa - cada etapa es
// un paso ordenado, no identidades distintas, así que va una rampa y no colores categóricos.
const DORADO_CLARO = [0xf0, 0xdc, 0x9c];
const DORADO_OSCURO = [0x7a, 0x5a, 0x14];
function interpolarHex(desde, hasta, t) {
  const canal = (i) => Math.round(desde[i] + (hasta[i] - desde[i]) * t);
  return '#' + [canal(0), canal(1), canal(2)].map((c) => c.toString(16).padStart(2, '0')).join('');
}
function rampaDorada(n) {
  if (n <= 1) return [interpolarHex(DORADO_CLARO, DORADO_OSCURO, 0.5)];
  return Array.from({ length: n }, (_, i) => interpolarHex(DORADO_CLARO, DORADO_OSCURO, i / (n - 1)));
}

// Paleta categórica (orden fijo, nunca se reordena por valor) - mismos 8 tonos validados
// para fondo oscuro.
const CATEGORICO = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const GRIS_SIN_DATO = '#6b7280';

const ORIGEN_INFO = {
  whatsapp_texto: { label: 'WhatsApp (texto)', color: CATEGORICO[0] },
  whatsapp_audio: { label: 'WhatsApp (audio)', color: CATEGORICO[2] },
  formulario: { label: 'Formulario', color: CATEGORICO[1] }
};
const ORIGEN_ORDEN = ['whatsapp_texto', 'whatsapp_audio', 'formulario'];

// ---------- Tooltip compartido ----------
const tooltipEl = document.getElementById('viz-tooltip');
function mostrarTooltip(e, label, valor) {
  tooltipEl.innerHTML = `<span class="tt-valor">${esc(valor)}</span><span class="tt-label">${esc(label)}</span>`;
  tooltipEl.classList.add('visible');
  moverTooltip(e);
}
function moverTooltip(e) {
  const x = e.clientX + 14;
  const y = e.clientY + 14;
  tooltipEl.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  tooltipEl.style.top = Math.min(y, window.innerHeight - 60) + 'px';
}
function ocultarTooltip() {
  tooltipEl.classList.remove('visible');
}

// ---------- Charts ----------
function renderColumnas(contId, items, { getLabel, getValor, getColor, formatearValor }) {
  const cont = document.getElementById(contId);
  const max = Math.max(1, ...items.map(getValor));
  cont.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'col-chart';
  items.forEach((item) => {
    const valor = getValor(item);
    const colWrap = document.createElement('div');
    colWrap.className = 'col-barra-wrap';
    const barra = document.createElement('div');
    barra.className = 'col-barra';
    barra.style.height = Math.max(2, (valor / max) * 100) + '%';
    barra.style.background = getColor(item);
    barra.tabIndex = 0;
    barra.addEventListener('pointermove', (e) => mostrarTooltip(e, getLabel(item), formatearValor(valor)));
    barra.addEventListener('pointerleave', ocultarTooltip);
    barra.addEventListener('focus', (e) => mostrarTooltip(e, getLabel(item), formatearValor(valor)));
    barra.addEventListener('blur', ocultarTooltip);
    const etiqueta = document.createElement('div');
    etiqueta.className = 'col-etiqueta';
    etiqueta.textContent = getLabel(item);
    colWrap.appendChild(barra);
    colWrap.appendChild(etiqueta);
    wrap.appendChild(colWrap);
  });
  cont.appendChild(wrap);
}

function renderBarras(contId, items, { getLabel, getValor, getColor, formatearValor }) {
  const cont = document.getElementById(contId);
  const max = Math.max(1, ...items.map(getValor));
  cont.innerHTML = '';
  items.forEach((item) => {
    const valor = getValor(item);
    const fila = document.createElement('div');
    fila.className = 'bar-fila';
    const etiqueta = document.createElement('div');
    etiqueta.className = 'bar-etiqueta';
    etiqueta.textContent = getLabel(item);
    const pista = document.createElement('div');
    pista.className = 'bar-pista';
    const rect = document.createElement('div');
    rect.className = 'bar-rect';
    rect.style.width = Math.max(2, (valor / max) * 100) + '%';
    rect.style.background = getColor(item);
    rect.tabIndex = 0;
    rect.addEventListener('pointermove', (e) => mostrarTooltip(e, getLabel(item), formatearValor(valor)));
    rect.addEventListener('pointerleave', ocultarTooltip);
    rect.addEventListener('focus', (e) => mostrarTooltip(e, getLabel(item), formatearValor(valor)));
    rect.addEventListener('blur', ocultarTooltip);
    pista.appendChild(rect);
    const valorTexto = document.createElement('span');
    valorTexto.className = 'bar-valor';
    valorTexto.textContent = formatearValor(valor);
    fila.appendChild(etiqueta);
    fila.appendChild(pista);
    fila.appendChild(valorTexto);
    cont.appendChild(fila);
  });
}

async function cargarEstadisticas() {
  const cont = document.getElementById('stats-contenido');
  let data;
  try {
    data = await api('/api/admin/estadisticas');
  } catch (err) {
    cont.innerHTML = `<div class="chart-card"><p class="chart-vacio">${esc(err.message)}</p></div>`;
    return;
  }

  cont.innerHTML = `
    <div class="kpi-row">
      <div class="kpi-tile">
        <div class="kpi-label">Leads totales</div>
        <div class="kpi-valor">${formatearNumero(data.kpis.total_leads)}</div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Valor en el embudo</div>
        <div class="kpi-valor"><span class="accent">${formatearARS(data.kpis.valor_total)}</span></div>
      </div>
      <div class="kpi-tile">
        <div class="kpi-label">Conversión a "${esc(data.kpis.nombre_ultima_columna)}"</div>
        <div class="kpi-valor">${data.kpis.tasa_conversion.toFixed(1)}%</div>
      </div>
    </div>

    <div class="chart-card">
      <h2>Embudo por etapa</h2>
      <p class="chart-sub">Cuántas fichas hay hoy en cada columna del tablero.</p>
      <div id="chart-embudo"></div>
    </div>

    <div class="chart-card">
      <h2>Valor del embudo por mes</h2>
      <p class="chart-sub">Suma del monto cargado en las fichas, por mes en que llegó el lead (últimos 12 meses).</p>
      <div id="chart-mes"></div>
    </div>

    <div class="chart-card">
      <h2>Origen de los leads</h2>
      <p class="chart-sub">Por dónde llegan las consultas.</p>
      <div id="chart-origen"></div>
    </div>

    <div class="chart-card" id="card-departamento">
      <h2>Por departamento</h2>
      <p class="chart-sub">Requiere tener departamentos configurados (etiquetá tus cuentas de WhatsApp desde el super-admin, y creá empleados en "Empleados").</p>
      <div id="chart-departamento"></div>
    </div>
  `;

  // Embudo por etapa
  if (data.embudo.length === 0) {
    document.getElementById('chart-embudo').innerHTML = '<p class="chart-vacio">Todavía no hay consultas.</p>';
  } else {
    const colores = rampaDorada(data.embudo.length);
    renderColumnas('chart-embudo', data.embudo, {
      getLabel: (c) => c.nombre,
      getValor: (c) => c.cantidad,
      getColor: (c) => colores[data.embudo.indexOf(c)],
      formatearValor: (v) => `${formatearNumero(v)} fichas`
    });
  }

  // Valor por mes
  const colorMes = rampaDorada(3)[1]; // el tono del medio de la rampa, como color único
  const hayValorEnAlgunMes = data.valor_por_mes.some((m) => m.monto_total > 0);
  if (!hayValorEnAlgunMes) {
    document.getElementById('chart-mes').innerHTML = '<p class="chart-vacio">Todavía no hay montos cargados en ninguna ficha.</p>';
  } else {
    renderColumnas('chart-mes', data.valor_por_mes, {
      getLabel: (m) => m.mes.slice(2).replace('-', '/'),
      getValor: (m) => m.monto_total,
      getColor: () => colorMes,
      formatearValor: (v) => formatearARS(v)
    });
  }

  // Origen de los leads - orden fijo, colores fijos por identidad (no por valor)
  const origenItems = ORIGEN_ORDEN
    .map((key) => ({ key, cantidad: data.origen.find((o) => o.origen === key)?.cantidad || 0 }))
    .filter((o) => o.cantidad > 0);
  if (origenItems.length === 0) {
    document.getElementById('chart-origen').innerHTML = '<p class="chart-vacio">Todavía no hay consultas.</p>';
  } else {
    renderBarras('chart-origen', origenItems, {
      getLabel: (o) => ORIGEN_INFO[o.key].label,
      getValor: (o) => o.cantidad,
      getColor: (o) => ORIGEN_INFO[o.key].color,
      formatearValor: (v) => `${formatearNumero(v)} fichas`
    });
  }

  // Por departamento - "General" (sin departamento) siempre gris, el resto en orden de aparición
  const deptItems = data.departamento
    .map((d) => ({ nombre: d.departamento || 'General (sin depto.)', cantidad: d.cantidad, esGeneral: !d.departamento }))
    .sort((a, b) => b.cantidad - a.cantidad);
  const hayDeptosReales = deptItems.some((d) => !d.esGeneral);
  if (!hayDeptosReales) {
    document.getElementById('chart-departamento').innerHTML = '<p class="chart-vacio">No hay departamentos configurados todavía.</p>';
  } else {
    let siguienteColor = 0;
    const colorPorNombre = {};
    deptItems.forEach((d) => {
      if (d.esGeneral) { colorPorNombre[d.nombre] = GRIS_SIN_DATO; return; }
      colorPorNombre[d.nombre] = CATEGORICO[siguienteColor % CATEGORICO.length];
      siguienteColor += 1;
    });
    renderBarras('chart-departamento', deptItems, {
      getLabel: (d) => d.nombre,
      getValor: (d) => d.cantidad,
      getColor: (d) => colorPorNombre[d.nombre],
      formatearValor: (v) => `${formatearNumero(v)} fichas`
    });
  }

  document.addEventListener('pointermove', (e) => {
    if (tooltipEl.classList.contains('visible')) moverTooltip(e);
  });
}

// ---------- Cabecera (nombre, rol, link Empleados) ----------
async function cargarCabecera() {
  const data = await api('/api/admin/tablero');
  if (data.cliente) {
    document.getElementById('user-nombre').textContent = data.cliente.nombre || '';
    document.getElementById('user-slug').textContent = data.cliente.slug || '';
    const iniciales = (data.cliente.nombre || '?')
      .split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    document.getElementById('user-avatar').textContent = iniciales || '?';
  }
  if (data.usuario) {
    const esGerencia = data.usuario.rol === 'gerencia';
    document.getElementById('user-rol').textContent = esGerencia
      ? 'Gerencia · ve todo'
      : `${data.usuario.nombre} · ${data.usuario.departamento}`;
    document.getElementById('nav-empleados').hidden = !esGerencia;
  }
  if (data.cliente) {
    document.getElementById('nav-salon').hidden = data.cliente.plan !== 'elite';
  }
}

async function cerrarSesion() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
document.getElementById('logout-btn').addEventListener('click', cerrarSesion);
document.getElementById('logout-btn-mobile').addEventListener('click', cerrarSesion);

cargarCabecera().catch(() => {});
cargarEstadisticas();

// ---------- Empleados (mismo comportamiento que en tablero.js) ----------
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
