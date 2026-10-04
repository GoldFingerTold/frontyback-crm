// Panel de super-admin: alta de clientes nuevos, conexión de su WhatsApp, y edición de
// las columnas del tablero de cada uno - todo lo que antes se hacía a mano con
// scripts/crear-cliente.js y tocando Mongo directo.

let CLIENTES = [];
let CODIGOS = [];
let PLANES = {};
let columnasEditando = null; // { clienteId, columnas: [{id,nombre}] }
let whatsappEditando = null; // { clienteId }

async function api(path, options = {}) {
  const res = await fetch('/api/superadmin' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mostrarPanel() {
  document.getElementById('login-view').hidden = true;
  document.getElementById('panel-view').hidden = false;
  cargarPlanes().catch((err) => {
    document.getElementById('planes-lista').innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  });
  cargarCodigos().catch((err) => {
    document.getElementById('codigos-lista').innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  });
  cargarClientes().catch((err) => {
    document.getElementById('clientes-lista').innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  });
}

function mostrarLogin() {
  document.getElementById('panel-view').hidden = true;
  document.getElementById('login-view').hidden = false;
}

async function chequearSesion() {
  try {
    const data = await api('/session');
    if (data.autenticado) mostrarPanel();
    else mostrarLogin();
  } catch {
    mostrarLogin();
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('login-status');
  status.textContent = 'Ingresando...';
  status.className = 'form-status';
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        usuario: document.getElementById('sa-usuario').value.trim(),
        password: document.getElementById('sa-password').value
      })
    });
    status.textContent = '';
    mostrarPanel();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

document.getElementById('sa-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  mostrarLogin();
});

function formatearFecha(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

async function cargarClientes() {
  const data = await api('/clientes');
  CLIENTES = data.clientes;
  renderClientes();
}

const PLANES_NOMBRES = { esencial: 'Esencial', completo: 'Profesional', premium: 'Premium' };

function diasRestantes(fechaIso) {
  if (!fechaIso) return null;
  const ms = new Date(fechaIso).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function tagEstadoPago(c) {
  if (c.estado_pago === 'activo') return '<span class="sa-tag sa-tag-ok"><i class="fa-solid fa-check"></i> Activo</span>';
  if (c.estado_pago === 'vencido_gracia') {
    const dias = Math.max(diasRestantes(c.gracia_termina) ?? 0, 0);
    return `<span class="sa-tag" style="color: var(--danger); border-color: var(--danger);">En gracia · ${dias}d</span>`;
  }
  if (c.estado_pago === 'vencido_cortado') return '<span class="sa-tag" style="color: var(--danger); border-color: var(--danger);">Cortado</span>';
  if (c.estado_pago === 'cancelado') return '<span class="sa-tag">Cancelado</span>';
  if (c.estado_pago === 'prueba') {
    const dias = diasRestantes(c.prueba_termina);
    const texto = dias === null ? 'Prueba' : dias >= 0 ? `Prueba · ${dias}d` : 'Prueba vencida';
    return `<span class="sa-tag" style="color: var(--accent-gold); border-color: rgba(212,175,55,0.3);">${esc(texto)}</span>`;
  }
  return '<span class="sa-tag">—</span>';
}

function renderClientes() {
  const cont = document.getElementById('clientes-lista');
  if (CLIENTES.length === 0) {
    cont.innerHTML = '<p class="loading">Todavía no hay clientes creados.</p>';
    return;
  }
  cont.innerHTML = `
    <table class="sa-table">
      <thead>
        <tr>
          <th>Negocio</th>
          <th>Usuario</th>
          <th>Plan</th>
          <th>Estado</th>
          <th>Código</th>
          <th>WhatsApp</th>
          <th>Alta</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${CLIENTES.map((c) => `
          <tr>
            <td>${esc(c.nombre)}</td>
            <td>${esc(c.slug)}</td>
            <td>${c.plan ? `${esc(PLANES_NOMBRES[c.plan] || c.plan)} · $${c.precio_pactado ?? '—'} ${c.frecuencia_pago === 'anual' ? '/año' : '/mes'}` : '—'}</td>
            <td>${tagEstadoPago(c)}</td>
            <td>${c.codigo_referido ? esc(c.codigo_referido) : '—'}</td>
            <td>
              ${c.whatsapp_numeros && c.whatsapp_numeros.length > 0
                ? `<span class="sa-tag sa-tag-ok"><i class="fa-solid fa-check"></i> ${c.whatsapp_numeros.length}</span>`
                : '<span class="sa-tag">Sin conectar</span>'}
            </td>
            <td>${formatearFecha(c.created_at)}</td>
            <td class="sa-acciones">
              ${c.estado_pago !== 'activo' ? `<button type="button" class="btn-ghost" data-accion="marcar-activo" data-id="${c._id}" title="Marcar como pago confirmado"><i class="fa-solid fa-circle-dollar-to-slot"></i></button>` : ''}
              <button type="button" class="btn-ghost" data-accion="whatsapp" data-id="${c._id}"><i class="fa-brands fa-whatsapp"></i></button>
              <button type="button" class="btn-ghost" data-accion="columnas" data-id="${c._id}"><i class="fa-solid fa-table-columns"></i></button>
              <button type="button" class="btn-ghost" data-accion="editar" data-id="${c._id}" title="Editar cliente"><i class="fa-solid fa-pen"></i></button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  cont.querySelectorAll('[data-accion="whatsapp"]').forEach((btn) => {
    btn.addEventListener('click', () => abrirWhatsapp(btn.dataset.id));
  });
  cont.querySelectorAll('[data-accion="columnas"]').forEach((btn) => {
    btn.addEventListener('click', () => abrirColumnas(btn.dataset.id));
  });
  cont.querySelectorAll('[data-accion="marcar-activo"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Confirmás que este cliente ya pagó? Va a quedar marcado como Activo.')) return;
      await api(`/clientes/${btn.dataset.id}/estado-pago`, {
        method: 'PUT',
        body: JSON.stringify({ estado_pago: 'activo' })
      });
      await cargarClientes();
    });
  });
  cont.querySelectorAll('[data-accion="editar"]').forEach((btn) => {
    btn.addEventListener('click', () => abrirEditarCliente(btn.dataset.id));
  });
}

// ---------- Editor de cliente ----------
function abrirEditarCliente(clienteId) {
  const cliente = CLIENTES.find((c) => c._id === clienteId);
  if (!cliente) return;
  document.getElementById('ce-nombre').value = cliente.nombre || '';
  document.getElementById('ce-email').value = cliente.email_notificacion || '';
  document.getElementById('ce-plan').value = cliente.plan || '';
  document.getElementById('ce-frecuencia').value = cliente.frecuencia_pago || 'mensual';
  document.getElementById('ce-precio').value = cliente.precio_pactado ?? '';
  document.getElementById('ce-limite-audios').value = cliente.limite_audios_mes ?? '';
  document.getElementById('cliente-editar-status').textContent = '';
  document.getElementById('cliente-editar-form').dataset.id = clienteId;
  document.getElementById('cliente-editar-borrar').dataset.id = clienteId;
  document.getElementById('cliente-overlay').hidden = false;
}
document.getElementById('cliente-close').addEventListener('click', () => {
  document.getElementById('cliente-overlay').hidden = true;
});
document.getElementById('cliente-editar-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const clienteId = e.target.dataset.id;
  const status = document.getElementById('cliente-editar-status');
  status.textContent = 'Guardando...';
  status.className = 'ficha-monto-status';
  try {
    await api(`/clientes/${clienteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        nombre: document.getElementById('ce-nombre').value.trim(),
        email_notificacion: document.getElementById('ce-email').value.trim(),
        plan: document.getElementById('ce-plan').value || null,
        frecuencia_pago: document.getElementById('ce-frecuencia').value,
        precio_pactado: document.getElementById('ce-precio').value,
        limite_audios_mes: document.getElementById('ce-limite-audios').value
      })
    });
    await cargarClientes();
    document.getElementById('cliente-overlay').hidden = true;
  } catch (err) {
    status.textContent = err.message;
    status.className = 'ficha-monto-status error';
  }
});
document.getElementById('cliente-editar-borrar').addEventListener('click', async (e) => {
  const clienteId = e.target.closest('button').dataset.id;
  const cliente = CLIENTES.find((c) => c._id === clienteId);
  if (!cliente) return;
  if (!confirm(`¿Borrar a "${cliente.nombre}"? Se borran también todas sus consultas. Esto no se puede deshacer.`)) return;
  const status = document.getElementById('cliente-editar-status');
  try {
    await api(`/clientes/${clienteId}`, { method: 'DELETE' });
    document.getElementById('cliente-overlay').hidden = true;
    await cargarClientes();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'ficha-monto-status error';
  }
});

// ---------- Nuevo cliente ----------
document.getElementById('nuevo-cliente-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('nuevo-cliente-status');
  status.textContent = 'Creando...';
  status.className = 'form-status';
  try {
    await api('/clientes', {
      method: 'POST',
      body: JSON.stringify({
        nombre: document.getElementById('nc-nombre').value.trim(),
        slug: document.getElementById('nc-slug').value.trim(),
        email_notificacion: document.getElementById('nc-email').value.trim(),
        password: document.getElementById('nc-password').value
      })
    });
    status.textContent = 'Cliente creado.';
    document.getElementById('nuevo-cliente-form').reset();
    await cargarClientes();
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// Autocompletar el usuario a partir del nombre, para no tener que pensarlo (se puede editar igual).
document.getElementById('nc-nombre').addEventListener('input', (e) => {
  const slugInput = document.getElementById('nc-slug');
  if (slugInput.dataset.tocado === 'si') return;
  slugInput.value = e.target.value
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
});
document.getElementById('nc-slug').addEventListener('input', (e) => {
  e.target.dataset.tocado = 'si';
});

// ---------- Editor de WhatsApp (varias cuentas por cliente, según el tope del plan) ----------
function abrirWhatsapp(clienteId) {
  const cliente = CLIENTES.find((c) => c._id === clienteId);
  if (!cliente) return;
  whatsappEditando = { clienteId };
  document.getElementById('whatsapp-cliente-nombre').textContent = cliente.nombre;
  document.getElementById('whatsapp-status').textContent = '';
  document.getElementById('whatsapp-input').value = '';
  document.getElementById('whatsapp-etiqueta-input').value = '';
  renderWhatsappEditor(cliente);
  document.getElementById('whatsapp-overlay').hidden = false;
}

function renderWhatsappEditor(cliente) {
  const numeros = cliente.whatsapp_numeros || [];
  const max = cliente.plan ? (PLANES[cliente.plan]?.max_whatsapp ?? 1) : 1;
  document.getElementById('whatsapp-tope').textContent = `${numeros.length} de ${max} cuenta${max === 1 ? '' : 's'} usadas (según el plan ${cliente.plan ? (PLANES_NOMBRES[cliente.plan] || cliente.plan) : 'sin asignar'}).`;

  const cont = document.getElementById('whatsapp-lista');
  if (numeros.length === 0) {
    cont.innerHTML = '<p class="loading" style="padding: 0;">Todavía no hay ninguna cuenta conectada.</p>';
  } else {
    cont.innerHTML = numeros.map((n) => `
      <div class="sa-columna-fila">
        <div style="flex: 1; min-width: 0;">
          <div style="font-size: 13px; font-family: monospace;">${esc(n.phone_number_id)}</div>
          ${n.etiqueta ? `<div style="font-size: 11.5px; color: var(--text-muted);">${esc(n.etiqueta)}</div>` : ''}
        </div>
        <button type="button" class="btn-ghost sa-columna-borrar" data-borrar-numero="${esc(n.phone_number_id)}"><i class="fa-solid fa-trash"></i></button>
      </div>
    `).join('');
    cont.querySelectorAll('[data-borrar-numero]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const status = document.getElementById('whatsapp-status');
        try {
          await api(`/clientes/${whatsappEditando.clienteId}/whatsapp/${encodeURIComponent(btn.dataset.borrarNumero)}`, { method: 'DELETE' });
          await cargarClientes();
          renderWhatsappEditor(CLIENTES.find((c) => c._id === whatsappEditando.clienteId));
        } catch (err) {
          status.textContent = err.message;
        }
      });
    });
  }

  const puedeAgregar = numeros.length < max;
  document.getElementById('whatsapp-agregar-btn').disabled = !puedeAgregar;
  document.getElementById('whatsapp-input').disabled = !puedeAgregar;
  document.getElementById('whatsapp-etiqueta-input').disabled = !puedeAgregar;
}

document.getElementById('whatsapp-close').addEventListener('click', () => {
  document.getElementById('whatsapp-overlay').hidden = true;
});
document.getElementById('whatsapp-agregar-btn').addEventListener('click', async () => {
  const status = document.getElementById('whatsapp-status');
  const phoneNumberId = document.getElementById('whatsapp-input').value.trim();
  const etiqueta = document.getElementById('whatsapp-etiqueta-input').value.trim();
  if (!phoneNumberId) return;
  status.textContent = 'Agregando...';
  try {
    await api(`/clientes/${whatsappEditando.clienteId}/whatsapp`, {
      method: 'POST',
      body: JSON.stringify({ phone_number_id: phoneNumberId, etiqueta })
    });
    document.getElementById('whatsapp-input').value = '';
    document.getElementById('whatsapp-etiqueta-input').value = '';
    status.textContent = '';
    await cargarClientes();
    renderWhatsappEditor(CLIENTES.find((c) => c._id === whatsappEditando.clienteId));
  } catch (err) {
    status.textContent = err.message;
  }
});

// ---------- Editor de columnas ----------
function abrirColumnas(clienteId) {
  const cliente = CLIENTES.find((c) => c._id === clienteId);
  if (!cliente) return;
  columnasEditando = {
    clienteId,
    columnas: [...cliente.columnas].sort((a, b) => a.posicion - b.posicion).map((c) => ({ id: c.id, nombre: c.nombre }))
  };
  document.getElementById('columnas-titulo').textContent = `Columnas — ${cliente.nombre}`;
  document.getElementById('columnas-status').textContent = '';
  renderColumnasEditor();
  document.getElementById('columnas-overlay').hidden = false;
}

function renderColumnasEditor() {
  const cont = document.getElementById('columnas-lista');
  cont.innerHTML = columnasEditando.columnas.map((c, i) => `
    <div class="sa-columna-fila" data-idx="${i}">
      <div class="sa-columna-flechas">
        <button type="button" data-mover="arriba" data-idx="${i}" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" data-mover="abajo" data-idx="${i}" ${i === columnasEditando.columnas.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <input type="text" data-nombre-idx="${i}" value="${esc(c.nombre)}">
      <button type="button" class="btn-ghost sa-columna-borrar" data-borrar="${i}" ${columnasEditando.columnas.length <= 1 ? 'disabled' : ''}><i class="fa-solid fa-trash"></i></button>
    </div>
  `).join('');

  cont.querySelectorAll('[data-nombre-idx]').forEach((input) => {
    input.addEventListener('input', (e) => {
      columnasEditando.columnas[Number(e.target.dataset.nombreIdx)].nombre = e.target.value;
    });
  });
  cont.querySelectorAll('[data-mover]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const destino = btn.dataset.mover === 'arriba' ? idx - 1 : idx + 1;
      const arr = columnasEditando.columnas;
      [arr[idx], arr[destino]] = [arr[destino], arr[idx]];
      renderColumnasEditor();
    });
  });
  cont.querySelectorAll('[data-borrar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      columnasEditando.columnas.splice(Number(btn.dataset.borrar), 1);
      renderColumnasEditor();
    });
  });
}

document.getElementById('columna-nueva-btn').addEventListener('click', () => {
  const input = document.getElementById('columna-nueva-input');
  const nombre = input.value.trim();
  if (!nombre) return;
  const id = nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || ('col-' + Date.now());
  let idFinal = id;
  let sufijo = 2;
  while (columnasEditando.columnas.some((c) => c.id === idFinal)) {
    idFinal = `${id}-${sufijo}`;
    sufijo += 1;
  }
  columnasEditando.columnas.push({ id: idFinal, nombre });
  input.value = '';
  renderColumnasEditor();
});

document.getElementById('columnas-close').addEventListener('click', () => {
  document.getElementById('columnas-overlay').hidden = true;
});

document.getElementById('columnas-guardar').addEventListener('click', async () => {
  const status = document.getElementById('columnas-status');
  const nombresVacios = columnasEditando.columnas.some((c) => !c.nombre.trim());
  if (nombresVacios) {
    status.textContent = 'Ninguna columna puede quedar sin nombre.';
    return;
  }
  status.textContent = 'Guardando...';
  try {
    const data = await api(`/clientes/${columnasEditando.clienteId}/columnas`, {
      method: 'PUT',
      body: JSON.stringify({ columnas: columnasEditando.columnas })
    });
    status.textContent = data.fichasMigradas
      ? 'Guardado. Las fichas de las columnas borradas se movieron a la primera columna.'
      : 'Guardado.';
    await cargarClientes();
    setTimeout(() => { document.getElementById('columnas-overlay').hidden = true; }, data.fichasMigradas ? 2200 : 700);
  } catch (err) {
    status.textContent = err.message;
  }
});

// ---------- Planes y precios ----------

async function cargarPlanes() {
  const data = await api('/planes');
  PLANES = data.planes;
  renderPlanes(data.planes);
}

function renderPlanes(planes) {
  const cont = document.getElementById('planes-lista');
  const entradas = Object.values(planes).sort((a, b) => a.precio_ars - b.precio_ars);
  cont.innerHTML = entradas.map((p) => `
    <div class="sa-columna-fila" data-plan-id="${esc(p.id)}" style="margin-bottom: 10px; flex-wrap: wrap;">
      <div style="width: 90px; font-size: 13px; font-weight: 600; flex: none;">${esc(p.nombre)}</div>
      <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 160px;">
        <span style="color: var(--text-muted); font-size: 11px; width: 38px;">Mes $</span>
        <input type="number" min="1" step="1" data-campo="precio_ars" value="${p.precio_ars}" style="flex: 1;">
        <span style="color: var(--text-muted); font-size: 11px;">≈USD</span>
        <input type="number" min="1" step="1" data-campo="precio_usd_ref" value="${p.precio_usd_ref}" style="width: 55px;">
      </div>
      <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 160px;">
        <span style="color: var(--text-muted); font-size: 11px; width: 38px;">Año $</span>
        <input type="number" min="1" step="1" data-campo="precio_ars_anual" value="${p.precio_ars_anual}" style="flex: 1;">
        <span style="color: var(--text-muted); font-size: 11px;">≈USD</span>
        <input type="number" min="1" step="1" data-campo="precio_usd_ref_anual" value="${p.precio_usd_ref_anual}" style="width: 55px;">
      </div>
      <button type="button" class="btn-ghost" data-guardar-plan="${esc(p.id)}">Guardar</button>
    </div>
  `).join('') + '<p class="form-status" id="planes-status"></p>';

  cont.querySelectorAll('[data-guardar-plan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fila = btn.closest('[data-plan-id]');
      const status = document.getElementById('planes-status');
      status.textContent = 'Guardando...';
      status.className = 'form-status';
      try {
        await api(`/planes/${btn.dataset.guardarPlan}`, {
          method: 'PUT',
          body: JSON.stringify({
            precio_ars: fila.querySelector('[data-campo="precio_ars"]').value,
            precio_usd_ref: fila.querySelector('[data-campo="precio_usd_ref"]').value,
            precio_ars_anual: fila.querySelector('[data-campo="precio_ars_anual"]').value,
            precio_usd_ref_anual: fila.querySelector('[data-campo="precio_usd_ref_anual"]').value
          })
        });
        status.textContent = 'Guardado. Afecta a las altas nuevas (los clientes que ya están, siguen con su precio).';
        setTimeout(() => { status.textContent = ''; }, 3500);
      } catch (err) {
        status.textContent = err.message;
        status.className = 'form-status error';
      }
    });
  });
}

// ---------- Códigos de descuento / closers ----------

async function cargarCodigos() {
  const data = await api('/codigos');
  CODIGOS = data.codigos;
  renderCodigos();
}

function renderCodigos() {
  const cont = document.getElementById('codigos-lista');
  if (CODIGOS.length === 0) {
    cont.innerHTML = '<p class="loading">Todavía no creaste ningún código.</p>';
    return;
  }
  cont.innerHTML = `
    <table class="sa-table">
      <thead>
        <tr>
          <th>Código</th>
          <th>Closer</th>
          <th>Contacto</th>
          <th>Descuento</th>
          <th>Comisión</th>
          <th>Usos</th>
          <th>Estado</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${CODIGOS.map((c) => `
          <tr>
            <td>${esc(c.codigo)}</td>
            <td>${esc(c.nombre_closer)}</td>
            <td>${esc(c.contacto || '—')}</td>
            <td>${c.descuento_pct}%</td>
            <td>${c.comision_pct}%</td>
            <td>${c.usos_actuales ?? 0}${c.usos_maximos ? ' / ' + c.usos_maximos : ' / ∞'}</td>
            <td>${c.activo
              ? '<span class="sa-tag sa-tag-ok"><i class="fa-solid fa-check"></i> Activo</span>'
              : '<span class="sa-tag">Inactivo</span>'}</td>
            <td class="sa-acciones">
              <button type="button" class="btn-ghost" data-toggle-codigo="${c._id}" data-activo="${c.activo}">
                ${c.activo ? 'Desactivar' : 'Activar'}
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  cont.querySelectorAll('[data-toggle-codigo]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const activoActual = btn.dataset.activo === 'true';
      await api(`/codigos/${btn.dataset.toggleCodigo}/activo`, {
        method: 'PUT',
        body: JSON.stringify({ activo: !activoActual })
      });
      await cargarCodigos();
    });
  });
}

document.getElementById('nuevo-codigo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('nuevo-codigo-status');
  status.textContent = 'Creando...';
  status.className = 'form-status';
  try {
    await api('/codigos', {
      method: 'POST',
      body: JSON.stringify({
        codigo: document.getElementById('co-codigo').value.trim(),
        nombre_closer: document.getElementById('co-nombre').value.trim(),
        contacto: document.getElementById('co-contacto').value.trim(),
        descuento_pct: Number(document.getElementById('co-descuento').value),
        comision_pct: Number(document.getElementById('co-comision').value),
        usos_maximos: document.getElementById('co-usos').value.trim()
      })
    });
    status.textContent = 'Código creado.';
    document.getElementById('nuevo-codigo-form').reset();
    document.getElementById('co-descuento').value = 10;
    document.getElementById('co-comision').value = 10;
    await cargarCodigos();
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

chequearSesion();
