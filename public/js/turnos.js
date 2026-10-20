// Turnos (incluido desde el plan Esencial): agenda + configuración de servicios y
// disponibilidad semanal. La reserva en sí la hace el cliente final en /reservar.html,
// sin login - acá es donde Gerencia configura todo y el equipo ve la agenda.

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

const DIA_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

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
    document.getElementById('btn-servicios').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-recordatorios').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-disponibilidad').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-profesionales').hidden = !ESTADO.esGerencia;
    document.getElementById('btn-google-calendar').hidden = !ESTADO.esGerencia;
    if (ESTADO.esGerencia) actualizarEstadoCalendar();
  }
}

// ---------- Agenda ----------
async function cargarTurnos() {
  const cont = document.getElementById('tn-lista');
  try {
    const { turnos } = await api('/api/turnos');
    if (turnos.length === 0) {
      cont.innerHTML = '<p id="tn-vacio">No hay turnos reservados todavía. Compartí tu link de reservas para que empiecen a llegar.</p>';
      return;
    }
    const porFecha = {};
    turnos.forEach((t) => { (porFecha[t.fecha] ||= []).push(t); });

    cont.innerHTML = Object.entries(porFecha).map(([fecha, lista]) => {
      const d = new Date(fecha + 'T12:00:00');
      const tituloFecha = `${DIA_NOMBRE[d.getDay()]} ${fecha.split('-').reverse().slice(0, 2).join('/')}`;
      return `
        <div class="tn-fecha-grupo">
          <h3 class="tn-fecha-titulo">${esc(tituloFecha)}</h3>
          ${lista.map((t) => `
            <div class="tn-fila" data-turno-id="${t._id}">
              <div class="tn-hora">${esc(t.hora_inicio)}</div>
              <div class="tn-detalle">
                <div class="tn-servicio">${esc(t.servicio_nombre)}${t.profesional_nombre ? ` · ${esc(t.profesional_nombre)}` : ''}${t.estado === 'cancelado' ? ' · <span style="color: var(--danger);">Cancelado</span>' : ''}</div>
                <div class="tn-contacto">${esc(t.nombre_contacto)} · ${esc(t.telefono_contacto)}</div>
              </div>
              ${ESTADO.esGerencia && t.estado !== 'cancelado' ? `<button type="button" class="tn-cancelar" data-cancelar="${t._id}">Cancelar</button>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }).join('');

    cont.querySelectorAll('[data-cancelar]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Cancelar este turno?')) return;
        try {
          await api(`/api/turnos/${btn.dataset.cancelar}`, { method: 'DELETE' });
          cargarTurnos();
        } catch (err) {
          alert('No se pudo cancelar: ' + err.message);
        }
      });
    });
  } catch (err) {
    cont.innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

// ---------- Copiar link de reservas ----------
document.getElementById('btn-copiar-link').addEventListener('click', async () => {
  const link = `${location.origin}/reservar.html?slug=${encodeURIComponent(ESTADO.slug)}`;
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

// ---------- Servicios ----------
function filaServicio(servicio) {
  const div = document.createElement('div');
  div.className = 'tn-servicio-fila';
  div.innerHTML = `
    <input type="text" class="serv-nombre" placeholder="Nombre" value="${esc(servicio.nombre || '')}" maxlength="60">
    <input type="number" class="serv-duracion" placeholder="min" value="${servicio.duracion_min || 30}" min="10" max="480">
    <button type="button" class="btn-ghost serv-borrar" title="Borrar"><i class="fa-solid fa-trash"></i></button>
  `;
  div.querySelector('.serv-borrar').addEventListener('click', () => div.remove());
  return div;
}

async function abrirServicios() {
  document.getElementById('servicios-overlay').hidden = false;
  document.getElementById('servicios-status').textContent = '';
  const lista = document.getElementById('servicios-lista');
  lista.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    const config = await api('/api/turnos/config');
    lista.innerHTML = '';
    (config.servicios.length ? config.servicios : [{ nombre: '', duracion_min: 30 }]).forEach((s) => {
      lista.appendChild(filaServicio(s));
    });
  } catch (err) {
    lista.innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('btn-servicios').addEventListener('click', abrirServicios);
document.getElementById('servicios-close').addEventListener('click', () => {
  document.getElementById('servicios-overlay').hidden = true;
});
document.getElementById('servicio-agregar').addEventListener('click', () => {
  document.getElementById('servicios-lista').appendChild(filaServicio({ nombre: '', duracion_min: 30 }));
});
document.getElementById('servicios-guardar').addEventListener('click', async () => {
  const status = document.getElementById('servicios-status');
  const servicios = [...document.querySelectorAll('#servicios-lista .tn-servicio-fila')]
    .map((fila) => ({
      nombre: fila.querySelector('.serv-nombre').value.trim(),
      duracion_min: parseInt(fila.querySelector('.serv-duracion').value, 10) || 30
    }))
    .filter((s) => s.nombre);

  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/turnos/servicios', { method: 'PUT', body: JSON.stringify({ servicios }) });
    status.textContent = 'Guardado.';
    setTimeout(() => { document.getElementById('servicios-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Google Calendar ----------
async function actualizarEstadoCalendar() {
  try {
    const { conectado } = await api('/api/turnos/calendar/estado');
    const btn = document.getElementById('btn-google-calendar');
    const texto = document.getElementById('google-calendar-texto');
    btn.classList.toggle('btn-primary', conectado);
    texto.textContent = conectado ? 'Google Calendar conectado ✓' : 'Conectar Google Calendar';
  } catch {
    // si falla, dejamos el botón como estaba - no es crítico
  }
}

document.getElementById('btn-google-calendar').addEventListener('click', async () => {
  const { conectado } = await api('/api/turnos/calendar/estado');
  if (conectado) {
    if (!confirm('¿Desconectar Google Calendar? Los turnos van a dejar de crearse ahí.')) return;
    await api('/api/turnos/calendar/desconectar', { method: 'POST' });
    actualizarEstadoCalendar();
    return;
  }

  const { url } = await api('/api/turnos/calendar/conectar');
  const ventana = window.open(url, 'conectar-google-calendar', 'width=520,height=640');

  // Mientras la ventana de Google siga abierta, chequeamos cada 2s si ya se conectó, para
  // actualizar el botón solo sin que el usuario tenga que recargar la página a mano.
  const intervalo = setInterval(async () => {
    if (ventana && ventana.closed) {
      clearInterval(intervalo);
      actualizarEstadoCalendar();
      return;
    }
    const { conectado: yaConectado } = await api('/api/turnos/calendar/estado');
    if (yaConectado) {
      clearInterval(intervalo);
      actualizarEstadoCalendar();
      if (ventana && !ventana.closed) ventana.close();
    }
  }, 2000);
});

// ---------- Recordatorios (switches WhatsApp / email) ----------
async function abrirRecordatorios() {
  document.getElementById('recordatorios-overlay').hidden = false;
  document.getElementById('recordatorios-status').textContent = '';
  try {
    const config = await api('/api/turnos/config');
    document.getElementById('rec-whatsapp').checked = config.recordatorio_whatsapp === true;
    document.getElementById('rec-email').checked = config.recordatorio_email !== false;
  } catch (err) {
    document.getElementById('recordatorios-status').textContent = err.message;
  }
}

document.getElementById('btn-recordatorios').addEventListener('click', abrirRecordatorios);
document.getElementById('recordatorios-close').addEventListener('click', () => {
  document.getElementById('recordatorios-overlay').hidden = true;
});
document.getElementById('recordatorios-guardar').addEventListener('click', async () => {
  const status = document.getElementById('recordatorios-status');
  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/turnos/recordatorios', {
      method: 'PUT',
      body: JSON.stringify({
        whatsapp: document.getElementById('rec-whatsapp').checked,
        email: document.getElementById('rec-email').checked
      })
    });
    status.textContent = 'Guardado.';
    setTimeout(() => { document.getElementById('recordatorios-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Disponibilidad ----------
async function abrirDisponibilidad() {
  document.getElementById('disponibilidad-overlay').hidden = false;
  document.getElementById('disponibilidad-status').textContent = '';
  const lista = document.getElementById('disponibilidad-lista');
  lista.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    const config = await api('/api/turnos/config');
    lista.innerHTML = config.disponibilidad.map((d) => `
      <div class="tn-disp-fila" data-dia="${d.dia}">
        <input type="checkbox" class="disp-activo" ${d.activo ? 'checked' : ''}>
        <label class="dia">${esc(DIA_NOMBRE[d.dia])}</label>
        <input type="time" class="disp-desde" value="${esc(d.desde)}">
        <span>a</span>
        <input type="time" class="disp-hasta" value="${esc(d.hasta)}">
      </div>
    `).join('');
  } catch (err) {
    lista.innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('btn-disponibilidad').addEventListener('click', abrirDisponibilidad);
document.getElementById('disponibilidad-close').addEventListener('click', () => {
  document.getElementById('disponibilidad-overlay').hidden = true;
});
document.getElementById('disponibilidad-guardar').addEventListener('click', async () => {
  const status = document.getElementById('disponibilidad-status');
  const disponibilidad = [...document.querySelectorAll('#disponibilidad-lista .tn-disp-fila')].map((fila) => ({
    dia: parseInt(fila.dataset.dia, 10),
    activo: fila.querySelector('.disp-activo').checked,
    desde: fila.querySelector('.disp-desde').value || '09:00',
    hasta: fila.querySelector('.disp-hasta').value || '18:00'
  }));

  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/turnos/disponibilidad', { method: 'PUT', body: JSON.stringify({ disponibilidad }) });
    status.textContent = 'Guardado.';
    setTimeout(() => { document.getElementById('disponibilidad-overlay').hidden = true; }, 700);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

// ---------- Profesionales (horario propio por persona, en vez de uno solo compartido) ----------
const DISPONIBILIDAD_DEFAULT_PROFESIONAL = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
  dia, activo: dia >= 1 && dia <= 5, desde: '09:00', hasta: '18:00'
}));

function filaProfesional(profesional) {
  const div = document.createElement('div');
  div.className = 'tn-prof-card';
  if (profesional.id) div.dataset.id = profesional.id;
  div.innerHTML = `
    <div class="tn-prof-cabecera">
      <input type="text" class="prof-nombre" placeholder="Nombre del profesional" value="${esc(profesional.nombre || '')}" maxlength="60">
      <button type="button" class="btn-ghost prof-borrar" title="Borrar"><i class="fa-solid fa-trash"></i></button>
    </div>
    <div class="prof-horarios">
      ${profesional.disponibilidad.map((d) => `
        <div class="tn-prof-horario" data-dia="${d.dia}">
          <input type="checkbox" class="disp-activo" ${d.activo ? 'checked' : ''}>
          <label class="dia">${esc(DIA_NOMBRE[d.dia])}</label>
          <input type="time" class="disp-desde" value="${esc(d.desde)}">
          <span>a</span>
          <input type="time" class="disp-hasta" value="${esc(d.hasta)}">
        </div>
      `).join('')}
    </div>
  `;
  div.querySelector('.prof-borrar').addEventListener('click', () => div.remove());
  return div;
}

async function abrirProfesionales() {
  document.getElementById('profesionales-overlay').hidden = false;
  document.getElementById('profesionales-status').textContent = '';
  const lista = document.getElementById('profesionales-lista');
  lista.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    const config = await api('/api/turnos/config');
    lista.innerHTML = '';
    (config.profesionales || []).forEach((p) => lista.appendChild(filaProfesional(p)));
  } catch (err) {
    lista.innerHTML = `<p class="loading">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('btn-profesionales').addEventListener('click', abrirProfesionales);
document.getElementById('profesionales-close').addEventListener('click', () => {
  document.getElementById('profesionales-overlay').hidden = true;
});
document.getElementById('profesional-agregar').addEventListener('click', () => {
  document.getElementById('profesionales-lista').appendChild(
    filaProfesional({ nombre: '', disponibilidad: DISPONIBILIDAD_DEFAULT_PROFESIONAL })
  );
});
document.getElementById('profesionales-guardar').addEventListener('click', async () => {
  const status = document.getElementById('profesionales-status');
  const profesionales = [...document.querySelectorAll('#profesionales-lista .tn-prof-card')]
    .map((card) => ({
      id: card.dataset.id || undefined,
      nombre: card.querySelector('.prof-nombre').value.trim(),
      disponibilidad: [...card.querySelectorAll('.tn-prof-horario')].map((fila) => ({
        dia: parseInt(fila.dataset.dia, 10),
        activo: fila.querySelector('.disp-activo').checked,
        desde: fila.querySelector('.disp-desde').value || '09:00',
        hasta: fila.querySelector('.disp-hasta').value || '18:00'
      }))
    }))
    .filter((p) => p.nombre);

  status.textContent = 'Guardando...';
  status.className = 'form-status';
  try {
    await api('/api/turnos/profesionales', { method: 'PUT', body: JSON.stringify({ profesionales }) });
    status.textContent = 'Guardado.';
    setTimeout(() => { document.getElementById('profesionales-overlay').hidden = true; }, 700);
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

cargarCabecera().then(cargarTurnos).catch(() => {});
