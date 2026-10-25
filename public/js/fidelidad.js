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
  if (!res.ok) throw new Error(data.error || tp('comun.error_red'));
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
      ? tp('fidelidad.rol_gerencia')
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
      cont.innerHTML = `<p id="fd-vacio">${esc(tp('fidelidad.vacio'))}</p>`;
      return;
    }
    const maximo = config.premios.length ? config.premios[config.premios.length - 1].puntos_necesarios : 0;
    cont.innerHTML = clientes.map((c) => {
      const tienePremio = config.premios.some((p) => c.puntos >= p.puntos_necesarios);
      return `
        <div class="fd-fila">
          <div class="fd-info">
            <div class="fd-nombre">${esc(c.nombre)}</div>
            <div class="fd-tel">${esc(c.telefono || '')}</div>
          </div>
          <div class="fd-sellos ${tienePremio ? 'premio' : ''}">${tienePremio ? esc(tp('fidelidad.premio_badge')) + ' ' : ''}${esc(maximo ? tp('fidelidad.puntos_fila_max', { puntos: c.puntos, maximo }) : tp('fidelidad.puntos_fila', { puntos: c.puntos }))}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    cont.innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
}

// ---------- Link público ----------
document.getElementById('btn-copiar-link').addEventListener('click', async () => {
  const link = `${location.origin}/fidelizacion.html?slug=${encodeURIComponent(ESTADO.slug)}`;
  const btn = document.getElementById('btn-copiar-link');
  try {
    await navigator.clipboard.writeText(link);
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(tp('fidelidad.copiado'))}`;
    setTimeout(() => { btn.innerHTML = original; }, 2000);
  } catch {
    prompt(tp('fidelidad.copia_este_link'), link);
  }
});

// ---------- Configuración ----------
function filaPremio(premio) {
  const div = document.createElement('div');
  div.className = 'fd-premio-fila';
  div.innerHTML = `
    <input type="number" class="premio-puntos" placeholder="${esc(tp('fidelidad.premio_puntos_ph'))}" value="${premio.puntos_necesarios || ''}" min="1" max="1000">
    <input type="text" class="premio-desc" placeholder="${esc(tp('fidelidad.premio_desc_ph'))}" value="${esc(premio.descripcion || '')}" maxlength="120">
    <button type="button" class="btn-ghost premio-borrar" title="${esc(tp('fidelidad.borrar'))}"><i class="fa-solid fa-trash"></i></button>
  `;
  div.querySelector('.premio-borrar').addEventListener('click', () => div.remove());
  return div;
}

function actualizarVisibilidadMonto() {
  document.getElementById('config-monto-wrap').hidden = document.getElementById('config-modo').value !== 'monto';
}
document.getElementById('config-modo').addEventListener('change', actualizarVisibilidadMonto);

document.getElementById('btn-config').addEventListener('click', async () => {
  document.getElementById('config-overlay').hidden = false;
  document.getElementById('config-status').textContent = '';
  const lista = document.getElementById('config-premios-lista');
  lista.innerHTML = `<p class="loading">${esc(tp('comun.cargando'))}</p>`;
  try {
    const config = await api('/api/fidelidad/config');
    document.getElementById('config-modo').value = config.modo;
    document.getElementById('config-monto').value = config.monto_por_punto;
    actualizarVisibilidadMonto();
    lista.innerHTML = '';
    (config.premios.length ? config.premios : [{ puntos_necesarios: 10, descripcion: '' }]).forEach((p) => {
      lista.appendChild(filaPremio(p));
    });
  } catch (err) {
    lista.innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
});
document.getElementById('config-close').addEventListener('click', () => {
  document.getElementById('config-overlay').hidden = true;
});
document.getElementById('config-premio-agregar').addEventListener('click', () => {
  document.getElementById('config-premios-lista').appendChild(filaPremio({ puntos_necesarios: '', descripcion: '' }));
});
document.getElementById('config-guardar').addEventListener('click', async () => {
  const status = document.getElementById('config-status');
  const premios = [...document.querySelectorAll('#config-premios-lista .fd-premio-fila')]
    .map((fila) => ({
      puntos_necesarios: parseInt(fila.querySelector('.premio-puntos').value, 10) || 0,
      descripcion: fila.querySelector('.premio-desc').value.trim()
    }))
    .filter((p) => p.descripcion && p.puntos_necesarios > 0);

  status.textContent = tp('comun.guardando');
  status.className = 'form-status';
  try {
    await api('/api/fidelidad/config', {
      method: 'PUT',
      body: JSON.stringify({
        modo: document.getElementById('config-modo').value,
        monto_por_punto: document.getElementById('config-monto').value,
        premios
      })
    });
    status.textContent = tp('comun.guardado');
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
  document.getElementById('scanner-resultado').innerHTML = `<p class="loading">${esc(tp('fidelidad.scanner_apunta'))}</p>`;
  const video = document.getElementById('scanner-video');
  try {
    streamActivo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = streamActivo;
    await video.play();
    escaneando = true;
    requestAnimationFrame(cicloEscaneo);
  } catch (err) {
    document.getElementById('scanner-resultado').innerHTML = `<p class="loading">${esc(tp('fidelidad.error_camara', { mensaje: err.message }))}</p>`;
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

  if (CONFIG_ACTUAL && CONFIG_ACTUAL.modo === 'monto') {
    cont.innerHTML = `
      <div class="fd-resultado-ok">
        <p>${esc(tp('fidelidad.cuanto_gasto'))}</p>
        <div class="fd-monto-row">
          <input type="number" id="monto-input" min="1" placeholder="${esc(tp('fidelidad.gasto_ph'))}" autofocus>
          <button type="button" id="btn-sumar-monto">${esc(tp('fidelidad.sumar'))}</button>
        </div>
        <button type="button" class="btn-ghost" id="btn-cancelar-monto" style="width: 100%;">${esc(tp('comun.cancelar'))}</button>
      </div>
    `;
    document.getElementById('btn-cancelar-monto').addEventListener('click', () => {
      escaneando = true;
      cont.innerHTML = `<p class="loading">${esc(tp('fidelidad.scanner_apunta'))}</p>`;
      requestAnimationFrame(cicloEscaneo);
    });
    document.getElementById('btn-sumar-monto').addEventListener('click', () => {
      const monto = document.getElementById('monto-input').value;
      sellarYMostrar(codigo, monto);
    });
    return;
  }

  await sellarYMostrar(codigo);
}

async function sellarYMostrar(codigo, monto) {
  const cont = document.getElementById('scanner-resultado');
  cont.innerHTML = `<p class="loading">${esc(tp('fidelidad.sumando'))}</p>`;
  try {
    const { tarjeta, premios } = await api('/api/fidelidad/sellar', {
      method: 'POST',
      body: JSON.stringify({ codigo, monto })
    });
    const disponibles = premios.filter((p) => tarjeta.puntos >= p.puntos_necesarios);
    cont.innerHTML = `
      <div class="fd-resultado-ok">
        <div class="nom">${esc(tarjeta.nombre)}</div>
        <div class="progreso">${esc(tpn('fidelidad.puntos_tarjeta', tarjeta.puntos))}</div>
        ${disponibles.map((p) => `
          <div class="premio-fila-canje">
            <span>🎉 ${esc(tp('fidelidad.premio_linea', { descripcion: p.descripcion, puntos: p.puntos_necesarios }))}</span>
            <button type="button" class="btn-canjear-premio" data-premio-id="${p.id}">${esc(tp('fidelidad.canjear'))}</button>
          </div>
        `).join('')}
        <button type="button" class="btn-ghost" id="btn-seguir-escaneando" style="width: 100%; margin-top: 10px;">${esc(tp('fidelidad.escanear_otro'))}</button>
      </div>
    `;
    cont.querySelectorAll('.btn-canjear-premio').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/fidelidad/canjear', { method: 'POST', body: JSON.stringify({ codigo, premio_id: btn.dataset.premioId }) });
          cargarClientes();
          cerrarEscaner();
        } catch (err) {
          alert(tp('fidelidad.error_canjear', { mensaje: err.message }));
        }
      });
    });
    document.getElementById('btn-seguir-escaneando').addEventListener('click', () => {
      escaneando = true;
      cont.innerHTML = `<p class="loading">${esc(tp('fidelidad.scanner_apunta'))}</p>`;
      requestAnimationFrame(cicloEscaneo);
    });
    cargarClientes();
  } catch (err) {
    cont.innerHTML = `
      <p class="loading" style="color: var(--danger);">${esc(err.message)}</p>
      <button type="button" class="btn-ghost" id="btn-reintentar" style="width: 100%; margin-top: 10px;">${esc(tp('fidelidad.reintentar'))}</button>
    `;
    document.getElementById('btn-reintentar').addEventListener('click', () => {
      escaneando = true;
      cont.innerHTML = `<p class="loading">${esc(tp('fidelidad.scanner_apunta'))}</p>`;
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
      : `<option value="" disabled selected>${esc(tp('fidelidad.emp_sin_departamentos'))}</option>`;
  } catch (err) {
    document.getElementById('empleados-lista').innerHTML = `<p class="loading">${esc(tp('comun.error_con_mensaje', { mensaje: err.message }))}</p>`;
  }
}

function renderEmpleados(usuarios) {
  const cont = document.getElementById('empleados-lista');
  const empleados = usuarios.filter((u) => u.rol === 'departamento');
  if (empleados.length === 0) {
    cont.innerHTML = `<p class="loading" style="padding: 0;">${esc(tp('fidelidad.emp_ninguno'))}</p>`;
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
      if (!confirm(tp('fidelidad.emp_confirmar_borrar'))) return;
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
  status.textContent = tp('fidelidad.emp_agregando');
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
    status.textContent = tp('fidelidad.emp_agregado');
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
