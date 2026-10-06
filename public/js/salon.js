// Plano de salón (exclusivo del plan Elite): editor de la forma del local + mesas, y
// vista operativa para cambiar el estado de una mesa con un click. Todo en SVG plano,
// sin librerías - mismo criterio que el resto del CRM.

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

const NS = 'http://www.w3.org/2000/svg';
function elSVG(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const svg = document.getElementById('salon-svg');

const ESTADO = { salon: null, modoEdicion: false, esGerencia: false };

function distancia(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function puntoSVG(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

// ---------- Carga inicial ----------
async function cargarSalon() {
  try {
    ESTADO.salon = await api('/api/salon');
    renderSalon();
  } catch (err) {
    document.querySelector('.salon-canvas-wrap').innerHTML =
      `<p class="loading">${esc(err.message)}</p>`;
  }
}

async function cargarCabecera() {
  const data = await api('/api/admin/tablero');
  if (data.cliente) {
    document.getElementById('user-nombre').textContent = data.cliente.nombre || '';
    document.getElementById('user-slug').textContent = data.cliente.slug || '';
    const iniciales = (data.cliente.nombre || '?')
      .split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    document.getElementById('user-avatar').textContent = iniciales || '?';
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
    document.getElementById('btn-modo-edicion').hidden = !ESTADO.esGerencia;
  }
}

// ---------- Render ----------
function renderSalon() {
  svg.innerHTML = '';
  const salon = ESTADO.salon;
  if (!salon) return;

  const puntos = salon.forma.map((p) => `${p.x},${p.y}`).join(' ');
  svg.appendChild(elSVG('polygon', { points: puntos, class: 'pared' }));

  if (ESTADO.modoEdicion) {
    salon.forma.forEach((p, i) => {
      const q = salon.forma[(i + 1) % salon.forma.length];
      const mx = (p.x + q.x) / 2;
      const my = (p.y + q.y) / 2;
      const mid = elSVG('circle', { cx: mx, cy: my, r: 6, class: 'mid-punto' });
      mid.addEventListener('click', (e) => { e.stopPropagation(); abrirPopoverBorde(i, e); });
      svg.appendChild(mid);
    });
    salon.forma.forEach((p, i) => {
      const v = elSVG('circle', { cx: p.x, cy: p.y, r: 8, class: 'vertice' });
      v.addEventListener('dblclick', (e) => { e.stopPropagation(); borrarVertice(i); });
      hacerArrastrableVertice(v, i);
      svg.appendChild(v);
    });
  }

  document.getElementById('salon-sin-mesas').hidden = salon.mesas.length > 0;

  salon.mesas.forEach((mesa) => {
    const g = elSVG('g', { class: 'mesa-grupo' });
    const clase = `mesa mesa-${mesa.estado}`;
    const forma = mesa.tipo === 'circulo'
      ? elSVG('circle', { cx: mesa.x, cy: mesa.y, r: mesa.ancho / 2, class: clase })
      : elSVG('rect', { x: mesa.x - mesa.ancho / 2, y: mesa.y - mesa.alto / 2, width: mesa.ancho, height: mesa.alto, rx: 10, class: clase });
    g.appendChild(forma);

    const label = elSVG('text', { x: mesa.x, y: mesa.y - 2, class: 'mesa-label' });
    label.textContent = mesa.nombre;
    g.appendChild(label);

    const cap = elSVG('text', { x: mesa.x, y: mesa.y + 13, class: 'mesa-cap' });
    cap.textContent = `${mesa.capacidad}p${mesa.nota ? ' · 📝' : ''}`;
    g.appendChild(cap);

    hacerArrastrableMesa(g, mesa);
    svg.appendChild(g);
  });
}

function actualizarPosicionVisual(g, mesa) {
  const forma = g.querySelector(mesa.tipo === 'circulo' ? 'circle' : 'rect');
  if (mesa.tipo === 'circulo') {
    forma.setAttribute('cx', mesa.x);
    forma.setAttribute('cy', mesa.y);
  } else {
    forma.setAttribute('x', mesa.x - mesa.ancho / 2);
    forma.setAttribute('y', mesa.y - mesa.alto / 2);
  }
  const textos = g.querySelectorAll('text');
  textos[0].setAttribute('x', mesa.x);
  textos[0].setAttribute('y', mesa.y - 2);
  textos[1].setAttribute('x', mesa.x);
  textos[1].setAttribute('y', mesa.y + 13);
}

// ---------- Arrastre de vértices (forma del salón, solo Gerencia en modo edición) ----------
function hacerArrastrableVertice(handle, index) {
  handle.addEventListener('pointerdown', (evt) => {
    evt.stopPropagation();
    handle.setPointerCapture(evt.pointerId);
    const inicio = puntoSVG(evt);
    let movio = false;

    function mover(e2) {
      const p = puntoSVG(e2);
      if (distancia(p, inicio) > 3) movio = true;
      if (!movio) return;
      ESTADO.salon.forma[index] = { x: Math.round(p.x), y: Math.round(p.y) };
      handle.setAttribute('cx', ESTADO.salon.forma[index].x);
      handle.setAttribute('cy', ESTADO.salon.forma[index].y);
      const poligono = svg.querySelector('polygon.pared');
      poligono.setAttribute('points', ESTADO.salon.forma.map((pp) => `${pp.x},${pp.y}`).join(' '));
    }
    function soltar() {
      handle.removeEventListener('pointermove', mover);
      handle.removeEventListener('pointerup', soltar);
      if (movio) { renderSalon(); guardarForma(); }
    }
    handle.addEventListener('pointermove', mover);
    handle.addEventListener('pointerup', soltar);
  });
}

function agregarVertice(indexDespuesDe) {
  const forma = ESTADO.salon.forma;
  if (forma.length >= 40) return;
  const p = forma[indexDespuesDe];
  const q = forma[(indexDespuesDe + 1) % forma.length];
  const nuevo = { x: Math.round((p.x + q.x) / 2), y: Math.round((p.y + q.y) / 2) };
  forma.splice(indexDespuesDe + 1, 0, nuevo);
  renderSalon();
  guardarForma();
}

function borrarVertice(index) {
  const forma = ESTADO.salon.forma;
  if (forma.length <= 3) return;
  forma.splice(index, 1);
  renderSalon();
  guardarForma();
}

function centroidePoligono(forma) {
  let x = 0;
  let y = 0;
  forma.forEach((p) => { x += p.x; y += p.y; });
  return { x: x / forma.length, y: y / forma.length };
}

function clamp2000(n) { return Math.min(Math.max(Math.round(n), 0), 2000); }

// Reemplaza el segmento recto entre dos puntos por un arco (curva de Bézier cuadrática,
// aproximada con varios puntos rectos - como cualquier curva en una pantalla). El arco
// "abulta" hacia afuera del salón por default; para ajustar cuánto se curva, después se
// arrastra cualquiera de los puntos nuevos como un punto normal.
function curvarBorde(index) {
  const forma = ESTADO.salon.forma;
  const N = 6;
  if (forma.length + N > 40) {
    alert('El salón ya tiene demasiados puntos como para curvar otro borde (máximo 40).');
    return;
  }
  const p = forma[index];
  const q = forma[(index + 1) % forma.length];
  const centro = centroidePoligono(forma);
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const largo = Math.hypot(dx, dy) || 1;
  let perpX = -dy / largo;
  let perpY = dx / largo;
  const haciaFueraX = mx - centro.x;
  const haciaFueraY = my - centro.y;
  if (perpX * haciaFueraX + perpY * haciaFueraY < 0) { perpX = -perpX; perpY = -perpY; }
  const bulge = largo * 0.5;
  const cx = mx + perpX * bulge;
  const cy = my + perpY * bulge;

  const nuevos = [];
  for (let i = 1; i <= N; i++) {
    const t = i / (N + 1);
    const x = (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * cx + t * t * q.x;
    const y = (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * cy + t * t * q.y;
    nuevos.push({ x: clamp2000(x), y: clamp2000(y) });
  }
  forma.splice(index + 1, 0, ...nuevos);
  renderSalon();
  guardarForma();
}

function abrirPopoverBorde(index, evt) {
  cerrarPopover();
  const pop = document.createElement('div');
  pop.className = 'salon-popover';
  pop.style.width = '220px';
  pop.innerHTML = `
    <button class="popover-cerrar" type="button">&times;</button>
    <h3>Este borde</h3>
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <button type="button" class="btn-ghost" id="pop-punto">+ Agregar un punto</button>
      <button type="button" class="btn btn-primary" id="pop-curvar">Curvar este borde</button>
    </div>
  `;
  posicionarPopover(pop, evt);
  popoverActual = pop;
  pop.querySelector('.popover-cerrar').addEventListener('click', cerrarPopover);
  pop.querySelector('#pop-punto').addEventListener('click', () => { agregarVertice(index); cerrarPopover(); });
  pop.querySelector('#pop-curvar').addEventListener('click', () => { curvarBorde(index); cerrarPopover(); });
}

async function guardarForma() {
  try {
    await api('/api/salon/forma', { method: 'PUT', body: JSON.stringify({ forma: ESTADO.salon.forma }) });
  } catch (err) {
    alert('No se pudo guardar la forma del salón: ' + err.message);
    cargarSalon();
  }
}

// ---------- Arrastre de mesas (solo en modo edición) + click para abrir popover ----------
function hacerArrastrableMesa(g, mesa) {
  g.addEventListener('pointerdown', (evt) => {
    g.setPointerCapture(evt.pointerId);
    const inicio = puntoSVG(evt);
    const offX = mesa.x - inicio.x;
    const offY = mesa.y - inicio.y;
    let movio = false;

    function mover(e2) {
      if (!ESTADO.modoEdicion) return;
      const p = puntoSVG(e2);
      if (!movio && distancia(p, inicio) <= 3) return;
      movio = true;
      mesa.x = Math.round(p.x + offX);
      mesa.y = Math.round(p.y + offY);
      actualizarPosicionVisual(g, mesa);
    }
    function soltar(e2) {
      g.removeEventListener('pointermove', mover);
      g.removeEventListener('pointerup', soltar);
      if (movio) {
        guardarMesa(mesa.id, { x: mesa.x, y: mesa.y });
      } else {
        abrirPopoverMesa(mesa, e2);
      }
    }
    g.addEventListener('pointermove', mover);
    g.addEventListener('pointerup', soltar);
  });
}

async function guardarMesa(id, cambios) {
  try {
    ESTADO.salon = await api(`/api/salon/mesas/${id}`, { method: 'PUT', body: JSON.stringify(cambios) });
    renderSalon();
  } catch (err) {
    alert('No se pudo guardar: ' + err.message);
    cargarSalon();
  }
}

async function borrarMesa(id) {
  try {
    ESTADO.salon = await api(`/api/salon/mesas/${id}`, { method: 'DELETE' });
    renderSalon();
  } catch (err) {
    alert('No se pudo borrar la mesa: ' + err.message);
  }
}

// ---------- Popovers ----------
let popoverActual = null;
function cerrarPopover() {
  if (popoverActual) { popoverActual.remove(); popoverActual = null; }
}

function posicionarPopover(el, evt) {
  document.body.appendChild(el);
  const x = Math.min(evt.clientX, window.innerWidth - 280);
  const y = Math.min(evt.clientY, window.innerHeight - el.offsetHeight - 20);
  el.style.left = Math.max(10, x) + 'px';
  el.style.top = Math.max(10, y) + 'px';
}

function abrirPopoverMesa(mesa, evt) {
  cerrarPopover();
  const editando = ESTADO.modoEdicion && ESTADO.esGerencia;
  const pop = document.createElement('div');
  pop.className = 'salon-popover';

  if (editando) {
    pop.innerHTML = `
      <button class="popover-cerrar" type="button">&times;</button>
      <h3>Editar mesa</h3>
      <label>Nombre</label>
      <input type="text" id="pop-nombre" value="${esc(mesa.nombre)}" maxlength="40">
      <label>Forma</label>
      <select id="pop-tipo">
        <option value="rect" ${mesa.tipo !== 'circulo' ? 'selected' : ''}>Rectangular</option>
        <option value="circulo" ${mesa.tipo === 'circulo' ? 'selected' : ''}>Redonda</option>
      </select>
      <label>Capacidad (personas)</label>
      <input type="text" id="pop-capacidad" value="${mesa.capacidad}" inputmode="numeric">
      <div class="popover-botones">
        <button type="button" class="btn-ghost" id="pop-borrar" style="color:#e05454;">Borrar mesa</button>
        <button type="button" class="btn btn-primary" id="pop-guardar">Guardar</button>
      </div>
    `;
    posicionarPopover(pop, evt);
    popoverActual = pop;
    pop.querySelector('.popover-cerrar').addEventListener('click', cerrarPopover);
    pop.querySelector('#pop-guardar').addEventListener('click', () => {
      guardarMesa(mesa.id, {
        nombre: pop.querySelector('#pop-nombre').value.trim() || 'Mesa',
        tipo: pop.querySelector('#pop-tipo').value,
        capacidad: parseInt(pop.querySelector('#pop-capacidad').value, 10) || 1
      });
      cerrarPopover();
    });
    pop.querySelector('#pop-borrar').addEventListener('click', () => {
      if (confirm(`¿Borrar "${mesa.nombre}"?`)) borrarMesa(mesa.id);
      cerrarPopover();
    });
  } else {
    pop.innerHTML = `
      <button class="popover-cerrar" type="button">&times;</button>
      <h3>${esc(mesa.nombre)} · ${mesa.capacidad} personas</h3>
      <div class="estado-btns">
        <button type="button" data-estado="libre" class="${mesa.estado === 'libre' ? 'activo' : ''}">Libre</button>
        <button type="button" data-estado="ocupada" class="${mesa.estado === 'ocupada' ? 'activo' : ''}">Ocupada</button>
        <button type="button" data-estado="reservada" class="${mesa.estado === 'reservada' ? 'activo' : ''}">Reservada</button>
      </div>
      <label>Nota</label>
      <textarea id="pop-nota" maxlength="200">${esc(mesa.nota || '')}</textarea>
      <div class="popover-botones">
        <span></span>
        <button type="button" class="btn-ghost" id="pop-guardar-nota">Guardar nota</button>
      </div>
    `;
    posicionarPopover(pop, evt);
    popoverActual = pop;
    pop.querySelector('.popover-cerrar').addEventListener('click', cerrarPopover);
    pop.querySelectorAll('[data-estado]').forEach((btn) => {
      btn.addEventListener('click', () => {
        guardarMesa(mesa.id, { estado: btn.dataset.estado });
        cerrarPopover();
      });
    });
    pop.querySelector('#pop-guardar-nota').addEventListener('click', () => {
      guardarMesa(mesa.id, { nota: pop.querySelector('#pop-nota').value });
      cerrarPopover();
    });
  }
}

document.addEventListener('pointerdown', (evt) => {
  if (popoverActual && !popoverActual.contains(evt.target) && !evt.target.closest('.mesa-grupo')) {
    cerrarPopover();
  }
});

// ---------- Modo edición / agregar mesa ----------
document.getElementById('btn-modo-edicion').addEventListener('click', () => {
  ESTADO.modoEdicion = !ESTADO.modoEdicion;
  const btn = document.getElementById('btn-modo-edicion');
  btn.innerHTML = ESTADO.modoEdicion
    ? '<i class="fa-solid fa-check"></i> Listo'
    : '<i class="fa-solid fa-pen"></i> Editar salón';
  document.getElementById('btn-agregar-mesa').hidden = !ESTADO.modoEdicion;
  document.getElementById('btn-reiniciar-salon').hidden = !ESTADO.modoEdicion;
  document.getElementById('salon-ayuda').hidden = !ESTADO.modoEdicion;
  document.getElementById('salon-canvas-wrap').classList.toggle('modo-edicion', ESTADO.modoEdicion);
  cerrarPopover();
  renderSalon();
});

document.getElementById('btn-reiniciar-salon').addEventListener('click', async () => {
  if (!confirm('¿Reiniciar el salón? Se borran todas las mesas y la forma vuelve a ser un rectángulo en blanco. No se puede deshacer.')) return;
  try {
    ESTADO.salon = await api('/api/salon', { method: 'DELETE' });
    renderSalon();
  } catch (err) {
    alert('No se pudo reiniciar el salón: ' + err.message);
  }
});

document.getElementById('btn-agregar-mesa').addEventListener('click', async () => {
  const n = ESTADO.salon.mesas.length;
  const x = 120 + (n % 6) * 110;
  const y = 120 + Math.floor(n / 6) * 110;
  try {
    ESTADO.salon = await api('/api/salon/mesas', {
      method: 'POST',
      body: JSON.stringify({ nombre: `Mesa ${n + 1}`, x, y, ancho: 80, alto: 80, tipo: 'rect', capacidad: 4 })
    });
    renderSalon();
  } catch (err) {
    alert('No se pudo agregar la mesa: ' + err.message);
  }
});

// ---------- Sesión / Empleados (mismo comportamiento que estadisticas.js) ----------
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

cargarCabecera().catch(() => {});
cargarSalon();
