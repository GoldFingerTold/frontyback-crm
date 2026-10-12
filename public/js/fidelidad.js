// Fidelización con QR (incluido desde el plan Esencial): el negocio escanea el QR del
// cliente al cobrarle - cada sello corresponde a una compra real. El registro del cliente
// final y su tarjeta viven en /fidelizacion.html, sin login.

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

const ESTADO = { esGerencia: false, slug: '' };

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
      ? 'Gerencia · ve todo'
      : `${data.usuario.nombre} · ${data.usuario.departamento}`;
    document.getElementById('nav-empleados').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-config').hidden = !ESTADO.esGerencia;
  }
}

// ---------- Lista de clientes fidelizados ----------
let CONFIG_ACTUAL = null;

async function cargarClientes() {
  const cont = document.getElementById('fd-lista');
  try {
    const [{ clientes }, config] = await Promise.all([api('/api/fidelidad/clientes'), api('/api/fidelidad/config')]);
    CONFIG_ACTUAL = config;
    if (clientes.length === 0) {
      cont.innerHTML = '<p id="fd-vacio">Todavía no hay clientes registrados. Compartí el link de registro.</p>';
      return;
    }
    cont.innerHTML = clientes.map((c) => {
      const premio = c.sellos >= config.meta_sellos;
      return `
        <div class="fd-fila">
          <div class="fd-info">
            <div class="fd-nombre">${esc(c.nombre)}</div>
            <div class="fd-tel">${esc(c.telefono || '')}</div>
          </div>
          <div class="fd-sellos ${premio ? 'premio' : ''}">${premio ? '¡Premio! ' : ''}${c.sellos}/${config.meta_sellos}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    cont.innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

// ---------- Link público ----------
document.getElementById('btn-copiar-link').addEventListener('click', async () => {
  const link = `${location.origin}/fidelizacion.html?slug=${encodeURIComponent(ESTADO.slug)}`;
  const btn = document.getElementById('btn-copiar-link');
  try {
    await navigator.clipboard.writeText(link);
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> ¡Copiado!';
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch {
    prompt('Copiá este link:', link);
  }
});

// ---------- Configuración ----------
document.getElementById('btn-config').addEventListener('click', async () => {
  document.getElementById('config-overlay').hidden = false;
  document.getElementById('config-status').textContent = '';
  try {
    const config = await api('/api/fidelidad/config');
    document.getElementById('config-meta').value = config.meta_sellos;
    document.getElementById('config-premio').value = config.premio_descripcion;
  } catch (err) {
    document.getElementById('config-status').textContent = err.message;
  }
});
document.getElementById('config-close').addEventListener('click', () => {
  document.getElementById('config-overlay').hidden = true;
});
document.getElementById('config-guardar').addEventListener('click', async () => {
  const status = document.getElementById('config-status');
  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/fidelidad/config', {
      method: 'PUT',
      body: JSON.stringify({
        meta_sellos: document.getElementById('config-meta').value,
        premio_descripcion: document.getElementById('config-premio').value
      })
    });
    status.textContent = 'Guardado.';
    cargarClientes();
    setTimeout(() => { document.getElementById('config-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Escáner de QR ----------
let streamActivo = null;
let escaneando = false;

async function abrirEscaner() {
  document.getElementById('scanner-overlay').hidden = false;
  document.getElementById('scanner-resultado').innerHTML = '<p class="loading">Apuntá la cámara al QR del cliente...</p>';
  const video = document.getElementById('scanner-video');
  try {
    streamActivo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = streamActivo;
    await video.play();
    escaneando = true;
    requestAnimationFrame(cicloEscaneo);
  } catch (err) {
    document.getElementById('scanner-resultado').innerHTML = `<p class="loading">No se pudo abrir la cámara: ${esc(err.message)}. Revisá los permisos del navegador.</p>`;
  }
}

function cerrarEscaner() {
  escaneando = false;
  if (streamActivo) {
    streamActivo.getTracks().forEach((t) => t.stop());
    streamActivo = null;
  }
  document.getElementById('scanner-overlay').hidden = true;
}

function cicloEscaneo() {
  if (!escaneando) return;
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const resultado = jsQR(imageData.data, imageData.width, imageData.height);
    if (resultado && resultado.data) {
      escaneando = false;
      procesarCodigo(resultado.data.trim());
      return;
    }
  }
  requestAnimationFrame(cicloEscaneo);
}

async function procesarCodigo(codigo) {
  const cont = document.getElementById('scanner-resultado');
  cont.innerHTML = '<p class="loading">Sellando...</p>';
  try {
    const { tarjeta, meta_sellos, premio_descripcion } = await api('/api/fidelidad/sellar', {
      method: 'POST',
      body: JSON.stringify({ codigo })
    });
    const premio = tarjeta.sellos >= meta_sellos;
    cont.innerHTML = `
      <div class="fd-resultado-ok">
        <div class="nom">${esc(tarjeta.nombre)}</div>
        <div class="progreso">${tarjeta.sellos}/${meta_sellos}</div>
        ${premio ? `
          <div class="premio-banner">🎉 ¡Llegó al premio! ${esc(premio_descripcion)}</div>
          <button type="button" class="btn btn-primary" id="btn-canjear-ahora" style="width: 100%; margin-top: 12px;">Entregar y canjear</button>
        ` : ''}
        <button type="button" class="btn-ghost" id="btn-seguir-escaneando" style="width: 100%; margin-top: 10px;">Escanear otro</button>
      </div>
    `;
    if (premio) {
      document.getElementById('btn-canjear-ahora').addEventListener('click', async () => {
        try {
          await api('/api/fidelidad/canjear', { method: 'POST', body: JSON.stringify({ codigo }) });
          cargarClientes();
          cerrarEscaner();
        } catch (err) {
          alert('No se pudo canjear: ' + err.message);
        }
      });
    }
    document.getElementById('btn-seguir-escaneando').addEventListener('click', () => {
      escaneando = true;
      cont.innerHTML = '<p class="loading">Apuntá la cámara al QR del cliente...</p>';
      requestAnimationFrame(cicloEscaneo);
    });
    cargarClientes();
  } catch (err) {
    cont.innerHTML = `
      <p class="loading" style="color: var(--danger);">${esc(err.message)}</p>
      <button type="button" class="btn-ghost" id="btn-reintentar" style="width: 100%; margin-top: 10px;">Reintentar</button>
    `;
    document.getElementById('btn-reintentar').addEventListener('click', () => {
      escaneando = true;
      cont.innerHTML = '<p class="loading">Apuntá la cámara al QR del cliente...</p>';
      requestAnimationFrame(cicloEscaneo);
    });
  }
}

document.getElementById('btn-escanear').addEventListener('click', abrirEscaner);
document.getElementById('scanner-close').addEventListener('click', cerrarEscaner);

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

cargarCabecera().then(cargarClientes).catch(() => {});
