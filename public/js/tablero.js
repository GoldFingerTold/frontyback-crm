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
  whatsapp_audio: { icon: 'fa-solid fa-microphone', label: 'WhatsApp audio' }
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

function crearTarjeta(ficha) {
  const el = document.createElement('div');
  el.className = 'premium-card';
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
    </div>
    <div class="card-body">"${esc((ficha.ultimo_mensaje || ficha.mensaje || '').slice(0, 100))}"</div>
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
      fichasColumna.forEach((f) => lista.appendChild(crearTarjeta(f)));
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
    document.getElementById('nav-estadisticas').hidden = !(esGerencia && ESTADO.cliente?.plan === 'premium');
    document.getElementById('aviso-lead-label').hidden = !esGerencia;
    // Solo la primera vez - si se vuelve a pisar en cada refresh automático (cada 20s),
    // se perdería el clic del usuario si tocó el checkbox justo antes de que refresque.
    if (!avisoLeadInicializado && esGerencia) {
      document.getElementById('aviso-lead-checkbox').checked = ESTADO.cliente?.avisos_lead_email !== false;
      avisoLeadInicializado = true;
    }
  }

  const hoy = new Date().toDateString();
  const nuevasHoy = ESTADO.fichas.filter((f) => new Date(f.fecha_hora_recibido).toDateString() === hoy).length;
  document.getElementById('metrics-nuevas-hoy').textContent = `+${nuevasHoy} nuevas hoy`;

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

    <h3>Historial</h3>
    <div class="historial">${historial || '<p>Sin mensajes todavía.</p>'}</div>
  `;

  document.getElementById('monto-guardar').addEventListener('click', () => {
    guardarMonto(fichaId, document.getElementById('monto-input'), document.getElementById('monto-status'));
  });

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

cargarTablero().catch((err) => {
  document.getElementById('board').innerHTML = `<p class="loading">Error: ${err.message}</p>`;
});

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
