// Landing de ventas: muestra los planes (sacados del servidor, no hardcodeados acá, para
// no tener el precio en dos lugares distintos) y maneja el alta por autoservicio.

let PLANES = {};

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatearARS(n) {
  return '$' + Math.round(n).toLocaleString('es-AR');
}

async function cargarPlanes() {
  const res = await fetch('/api/public/planes');
  const data = await res.json();
  PLANES = data.planes;

  const cont = document.getElementById('planes');
  const select = document.getElementById('f-plan');
  const entradas = Object.entries(PLANES);

  cont.innerHTML = entradas.map(([id, p], i) => `
    <div class="pl-plan ${i === entradas.length - 1 ? 'destacado' : ''}">
      <div class="pl-plan-nombre">${esc(p.nombre)}</div>
      <div class="pl-plan-precio"><span class="num">${formatearARS(p.precio_ars)}</span><span class="per">ARS / mes (≈ USD ${p.precio_usd_ref} hoy)</span></div>
      <div class="pl-plan-desc">${esc(p.descripcion)}</div>
      <ul>${p.features.map((f) => `<li><i class="fa-solid fa-check"></i> ${esc(f)}</li>`).join('')}</ul>
      <button type="button" class="btn btn-primary" data-elegir="${esc(id)}">Elegir ${esc(p.nombre)}</button>
    </div>
  `).join('');

  select.innerHTML = entradas.map(([id, p]) => `<option value="${esc(id)}">${esc(p.nombre)} — ${formatearARS(p.precio_ars)}/mes</option>`).join('');

  cont.querySelectorAll('[data-elegir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      select.value = btn.dataset.elegir;
      actualizarPrecio();
      document.getElementById('f-nombre').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  actualizarPrecio();
}

let codigoInfo = null;

function actualizarPrecio() {
  const plan = PLANES[document.getElementById('f-plan').value];
  if (!plan) return;
  const el = document.getElementById('precio-final');
  if (codigoInfo && codigoInfo.valido) {
    const final = Math.round(plan.precio_ars * (1 - codigoInfo.descuento_pct / 100));
    el.innerHTML = `Con el descuento: <strong>${formatearARS(final)} ARS/mes</strong> <span style="text-decoration: line-through; opacity: .6;">${formatearARS(plan.precio_ars)}</span>`;
  } else {
    el.textContent = '';
  }
}

document.getElementById('f-plan').addEventListener('change', actualizarPrecio);

let codigoTimeout;
// Si el usuario tipea rápido, pueden salir varios pedidos al servidor seguidos - y no hay
// garantía de que las respuestas vuelvan en el mismo orden en que se mandaron. Por eso cada
// pedido lleva un número de secuencia: si vuelve una respuesta vieja después de una más
// nueva, se descarta en vez de pisar el resultado correcto.
let codigoSecuencia = 0;

document.getElementById('f-codigo').addEventListener('input', (e) => {
  clearTimeout(codigoTimeout);
  const valor = e.target.value.trim();
  const status = document.getElementById('codigo-status');
  const miSecuencia = ++codigoSecuencia;
  if (!valor) {
    status.textContent = '';
    status.className = 'pl-codigo-status';
    codigoInfo = null;
    actualizarPrecio();
    return;
  }
  codigoTimeout = setTimeout(async () => {
    try {
      const res = await fetch('/api/public/codigos/' + encodeURIComponent(valor));
      const data = await res.json();
      if (miSecuencia !== codigoSecuencia) return; // llegó tarde, ya no es la última consulta
      codigoInfo = data;
      if (data.valido) {
        status.textContent = `Código válido: ${data.descuento_pct}% de descuento`;
        status.className = 'pl-codigo-status ok';
      } else {
        status.textContent = 'Ese código no existe o ya no está activo.';
        status.className = 'pl-codigo-status bad';
      }
      actualizarPrecio();
    } catch {
      // si falla la verificación en vivo no bloqueamos el formulario, se revalida al enviar
    }
  }, 400);
});

document.getElementById('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('signup-status');
  status.className = 'form-status';
  status.textContent = 'Creando tu cuenta...';

  try {
    const res = await fetch('/api/public/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        nombre: document.getElementById('f-nombre').value.trim(),
        slug: document.getElementById('f-slug').value.trim(),
        email: document.getElementById('f-email').value.trim(),
        password: document.getElementById('f-password').value,
        plan: document.getElementById('f-plan').value,
        codigo: document.getElementById('f-codigo').value.trim(),
        _hp: document.getElementById('f-hp').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear la cuenta.');
    window.location.href = '/tablero.html';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

cargarPlanes().catch(() => {
  document.getElementById('planes').innerHTML = '<p class="loading">No se pudieron cargar los planes.</p>';
});
