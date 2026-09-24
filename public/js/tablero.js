// Tablero Kanban: arma las columnas y las fichas a partir de /api/admin/tablero, y deja
// arrastrar las fichas entre columnas (drag-and-drop nativo del navegador, sin librerías).

let ESTADO = { columnas: [], fichas: [] };

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    window.location.href = '/index.html';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de red');
  return data;
}

function etiquetaOrigen(origen) {
  return {
    formulario: '✉️ Formulario',
    whatsapp_texto: '💬 WhatsApp',
    whatsapp_audio: '🎙️ WhatsApp (audio)'
  }[origen] || origen;
}

function formatearFecha(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function crearTarjeta(ficha) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.id = ficha._id;

  el.innerHTML = `
    <div class="card-origen">${etiquetaOrigen(ficha.ultimo_origen || ficha.origen)}</div>
    <div class="card-nombre">${ficha.nombre || ficha.contacto}</div>
    <div class="card-mensaje">${(ficha.ultimo_mensaje || ficha.mensaje || '').slice(0, 90)}</div>
    <div class="card-fecha">${formatearFecha(ficha.fecha_hora_ultimo_mensaje || ficha.fecha_hora_recibido)}</div>
  `;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', ficha._id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', () => abrirFicha(ficha._id));

  return el;
}

function renderTablero() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  const columnasOrdenadas = [...ESTADO.columnas].sort((a, b) => a.posicion - b.posicion);

  columnasOrdenadas.forEach((columna) => {
    const col = document.createElement('div');
    col.className = 'column';
    col.dataset.columnaId = columna.id;

    const fichasColumna = ESTADO.fichas
      .filter((f) => f.columna_id === columna.id)
      .sort((a, b) => a.posicion - b.posicion);

    col.innerHTML = `<h2>${columna.nombre} <span class="count">${fichasColumna.length}</span></h2>`;
    const lista = document.createElement('div');
    lista.className = 'column-list';
    fichasColumna.forEach((f) => lista.appendChild(crearTarjeta(f)));
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

function abrirFicha(fichaId) {
  const ficha = ESTADO.fichas.find((f) => f._id === fichaId);
  if (!ficha) return;

  const historial = (ficha.historial || [])
    .slice()
    .reverse()
    .map((h) => `
      <div class="hist-item hist-${h.tipo}">
        <div class="hist-meta">${h.tipo === 'respuesta_saliente' ? 'Respondimos' : 'Escribió'} · ${etiquetaOrigen(h.origen || h.canal)} · ${formatearFecha(h.fecha_hora)}</div>
        <div class="hist-texto">${h.contenido}</div>
      </div>
    `).join('');

  document.getElementById('ficha-body').innerHTML = `
    <h2>${ficha.nombre || '(sin nombre)'}</h2>
    <p class="ficha-contacto">${ficha.contacto}</p>
    <p class="ficha-meta">Recibido: ${formatearFecha(ficha.fecha_hora_recibido)}</p>
    <h3>Historial</h3>
    <div class="historial">${historial || '<p>Sin mensajes todavía.</p>'}</div>
  `;
  document.getElementById('ficha-overlay').hidden = false;
}

document.getElementById('ficha-close').addEventListener('click', () => {
  document.getElementById('ficha-overlay').hidden = true;
});
document.getElementById('ficha-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'ficha-overlay') document.getElementById('ficha-overlay').hidden = true;
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/index.html';
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
