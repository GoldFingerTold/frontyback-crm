// Catálogo + pedidos por WhatsApp (incluido desde el plan Esencial): el pedido en sí lo
// arma y lo manda el cliente final desde /pedir.html, sin pasar por el servidor - acá es
// donde Gerencia carga los productos y el teléfono que recibe los pedidos.

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

function formatearPrecio(n) {
  return '$' + PanelI18n.numero(Math.round(n || 0));
}

const ESTADO = { esGerencia: false, slug: '', editandoId: null };

// ---------- Cabecera ----------
async function cargarCabecera() {
  const data = await api('/api/admin/tablero');
  if (data.cliente) {
    document.getElementById('user-nombre').textContent = data.cliente.nombre || '';
    document.getElementById('user-slug').textContent = data.cliente.slug || '';
    const iniciales = (data.cliente.nombre || '?')
      .split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    document.getElementById('user-avatar').textContent = iniciales || '?';
    ESTADO.slug = data.cliente.slug;
    const planConEstadisticas = data.cliente.plan === 'premium' || data.cliente.plan === 'elite';
    document.getElementById('nav-estadisticas').hidden = !planConEstadisticas;
    document.getElementById('nav-salon').hidden = data.cliente.plan !== 'elite';
  }
  if (data.usuario) {
    ESTADO.esGerencia = data.usuario.rol === 'gerencia';
    document.getElementById('user-rol').textContent = ESTADO.esGerencia
      ? tp('catalogo.rol_gerencia')
      : `${data.usuario.nombre} · ${data.usuario.departamento}`;
    document.getElementById('nav-empleados').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-telefono').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-agregar-item').hidden = !ESTADO.esGerencia;
  }
}

// ---------- Lista de productos ----------
async function cargarCatalogo() {
  const cont = document.getElementById('ct-lista');
  try {
    const { items } = await api('/api/catalogo');
    if (items.length === 0) {
      cont.innerHTML = `<p id="ct-vacio">${esc(tp('catalogo.vacio'))}</p>`;
      return;
    }
    const porCategoria = {};
    items.forEach((i) => { (porCategoria[i.categoria] ||= []).push(i); });

    cont.innerHTML = Object.entries(porCategoria).map(([categoria, lista]) => `
      <h3 class="ct-categoria">${esc(categoria)}</h3>
      ${lista.map((i) => `
        <div class="ct-fila ${i.disponible ? '' : 'no-disponible'}" data-item-id="${i._id}">
          <div class="ct-info">
            <div class="ct-nombre">${esc(i.nombre)}${i.disponible ? '' : ` · <span style="color: var(--text-muted);">${esc(tp('catalogo.no_disponible'))}</span>`}</div>
            ${i.descripcion ? `<div class="ct-desc">${esc(i.descripcion)}</div>` : ''}
          </div>
          <div class="ct-precio">${formatearPrecio(i.precio)}</div>
          ${ESTADO.esGerencia ? `
            <div class="ct-botones">
              <button type="button" data-editar="${i._id}" title="${esc(tp('catalogo.editar_title'))}"><i class="fa-solid fa-pen"></i></button>
              <button type="button" data-borrar="${i._id}" title="${esc(tp('catalogo.borrar_title'))}"><i class="fa-solid fa-trash"></i></button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    `).join('');

    window.__catalogoItems = items;

    cont.querySelectorAll('[data-editar]').forEach((btn) => {
      btn.addEventListener('click', () => abrirItem(items.find((i) => i._id === btn.dataset.editar)));
    });
    cont.querySelectorAll('[data-borrar]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(tp('catalogo.confirmar_borrar'))) return;
        try {
          await api(`/api/catalogo/${btn.dataset.borrar}`, { method: 'DELETE' });
          cargarCatalogo();
        } catch (err) {
          alert(tp('catalogo.error_borrar', { mensaje: err.message }));
        }
      });
    });
  } catch (err) {
    cont.innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
}

// ---------- Link público ----------
document.getElementById('btn-copiar-link').addEventListener('click', async () => {
  const link = `${location.origin}/pedir.html?slug=${encodeURIComponent(ESTADO.slug)}`;
  const btn = document.getElementById('btn-copiar-link');
  try {
    await navigator.clipboard.writeText(link);
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(tp('catalogo.copiado'))}`;
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch {
    prompt(tp('catalogo.copia_este_link'), link);
  }
});

// ---------- Producto: agregar / editar ----------
function abrirItem(item) {
  ESTADO.editandoId = item ? item._id : null;
  document.getElementById('item-titulo').textContent = item ? tp('catalogo.editar_producto') : tp('catalogo.agregar_producto');
  document.getElementById('item-status').textContent = '';
  document.getElementById('item-nombre').value = item?.nombre || '';
  document.getElementById('item-descripcion').value = item?.descripcion || '';
  document.getElementById('item-precio').value = item?.precio ?? '';
  document.getElementById('item-categoria').value = item?.categoria || '';
  document.getElementById('item-disponible').checked = item ? !!item.disponible : true;
  document.getElementById('item-overlay').hidden = false;
}

document.getElementById('btn-agregar-item').addEventListener('click', () => abrirItem(null));
document.getElementById('item-close').addEventListener('click', () => {
  document.getElementById('item-overlay').hidden = true;
});
document.getElementById('item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('item-status');
  status.textContent = tp('comun.guardando');
  status.className = 'form-status';
  const datos = {
    nombre: document.getElementById('item-nombre').value.trim(),
    descripcion: document.getElementById('item-descripcion').value.trim(),
    precio: parseFloat(document.getElementById('item-precio').value) || 0,
    categoria: document.getElementById('item-categoria').value.trim(),
    disponible: document.getElementById('item-disponible').checked
  };
  try {
    if (ESTADO.editandoId) {
      await api(`/api/catalogo/${ESTADO.editandoId}`, { method: 'PUT', body: JSON.stringify(datos) });
    } else {
      await api('/api/catalogo', { method: 'POST', body: JSON.stringify(datos) });
    }
    document.getElementById('item-overlay').hidden = true;
    cargarCatalogo();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Teléfono de pedidos ----------
document.getElementById('btn-telefono').addEventListener('click', async () => {
  document.getElementById('telefono-overlay').hidden = false;
  document.getElementById('telefono-status').textContent = '';
  try {
    const config = await api('/api/catalogo/config');
    document.getElementById('telefono-input').value = config.telefono_pedidos || '';
  } catch (err) {
    document.getElementById('telefono-status').textContent = err.message;
  }
});
document.getElementById('telefono-close').addEventListener('click', () => {
  document.getElementById('telefono-overlay').hidden = true;
});
document.getElementById('telefono-guardar').addEventListener('click', async () => {
  const status = document.getElementById('telefono-status');
  status.textContent = tp('comun.guardando');
  status.className = 'form-status';
  try {
    await api('/api/catalogo/config', {
      method: 'PUT',
      body: JSON.stringify({ telefono_pedidos: document.getElementById('telefono-input').value.trim() })
    });
    status.textContent = tp('comun.guardado');
    setTimeout(() => { document.getElementById('telefono-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Sesión / Empleados (mismo comportamiento que el resto del CRM) ----------
async function cerrarSesion() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
document.getElementById('logout-btn').addEventListener('click', cerrarSesion);
document.getElementById('logout-btn-mobile').addEventListener('click', cerrarSesion);

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
      : `<option value="" disabled selected>${esc(tp('catalogo.emp_sin_departamentos'))}</option>`;
  } catch (err) {
    document.getElementById('empleados-lista').innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
}

function renderEmpleados(usuarios) {
  const cont = document.getElementById('empleados-lista');
  const empleados = usuarios.filter((u) => u.rol === 'departamento');
  if (empleados.length === 0) {
    cont.innerHTML = `<p class="loading" style="padding: 0;">${esc(tp('catalogo.emp_ninguno'))}</p>`;
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
      if (!confirm(tp('catalogo.emp_confirmar_borrar'))) return;
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
  status.textContent = tp('catalogo.emp_agregando');
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
    status.textContent = tp('catalogo.emp_agregado');
    document.getElementById('empleado-nuevo-form').reset();
    const { usuarios } = await api('/api/admin/usuarios');
    renderEmpleados(usuarios);
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

cargarCabecera().then(cargarCatalogo).catch(() => {});
