// Panel de super-admin: alta de clientes nuevos, conexión de su WhatsApp, y edición de
// las columnas del tablero de cada uno - todo lo que antes se hacía a mano con
// scripts/crear-cliente.js y tocando Mongo directo.

let CLIENTES = [];
let columnasEditando = null; // { clienteId, columnas: [{id,nombre}] }

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
            <td>
              ${c.whatsapp_phone_number_id
                ? '<span class="sa-tag sa-tag-ok"><i class="fa-solid fa-check"></i> Conectado</span>'
                : '<span class="sa-tag">Sin conectar</span>'}
            </td>
            <td>${formatearFecha(c.created_at)}</td>
            <td class="sa-acciones">
              <button type="button" class="btn-ghost" data-accion="whatsapp" data-id="${c._id}"><i class="fa-brands fa-whatsapp"></i></button>
              <button type="button" class="btn-ghost" data-accion="columnas" data-id="${c._id}"><i class="fa-solid fa-table-columns"></i></button>
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
}

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

// ---------- Editor de WhatsApp ----------
function abrirWhatsapp(clienteId) {
  const cliente = CLIENTES.find((c) => c._id === clienteId);
  if (!cliente) return;
  document.getElementById('whatsapp-cliente-nombre').textContent = cliente.nombre;
  document.getElementById('whatsapp-input').value = cliente.whatsapp_phone_number_id || '';
  document.getElementById('whatsapp-status').textContent = '';
  document.getElementById('whatsapp-guardar').dataset.id = clienteId;
  document.getElementById('whatsapp-overlay').hidden = false;
}
document.getElementById('whatsapp-close').addEventListener('click', () => {
  document.getElementById('whatsapp-overlay').hidden = true;
});
document.getElementById('whatsapp-guardar').addEventListener('click', async (e) => {
  const clienteId = e.target.dataset.id;
  const status = document.getElementById('whatsapp-status');
  status.textContent = 'Guardando...';
  try {
    await api(`/clientes/${clienteId}/whatsapp`, {
      method: 'PUT',
      body: JSON.stringify({ whatsapp_phone_number_id: document.getElementById('whatsapp-input').value.trim() })
    });
    await cargarClientes();
    document.getElementById('whatsapp-overlay').hidden = true;
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

chequearSesion();
