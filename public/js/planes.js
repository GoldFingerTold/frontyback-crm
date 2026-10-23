// Landing de ventas: muestra los planes (sacados del servidor, no hardcodeados acá, para
// no tener el precio en dos lugares distintos), maneja el alta por autoservicio, y el
// idioma de la página (público/i18n/{es,en,pt}.json).
//
// Dos recorridos según de dónde venga el visitante (server/routes/public.js, GET /geo lee
// la IP real con geoip-lite):
// - Argentina: como siempre - elige un plan, completa el formulario de alta, arranca una
//   prueba de 7 días sin tarjeta, paga después por Mercado Pago.
// - Cualquier otro país: no hay formulario de alta acá - el precio se muestra en USD y el
//   botón va directo al checkout de Hotmart de ese plan (el período de prueba y la tarjeta
//   los maneja Hotmart de su lado). La cuenta del CRM se crea sola cuando Hotmart confirma
//   el pago (server/routes/webhooks.js, POST /webhook/hotmart).
//
// El idioma es un eje aparte del país: decide el TEXTO que se muestra, no la pasarela de
// pago - un visitante de España ve precios en USD/Hotmart igual que uno de Alemania, pero
// en español en vez de inglés.

let PLANES = {};
let HOTMART_LINKS = {};
let PAIS = 'AR';
let IDIOMA = 'es';
let DICT = {};
const DICCIONARIOS_CACHE = {};
const IDIOMAS_SOPORTADOS = ['es', 'en', 'pt'];
const COOKIE_IDIOMA = 'frontyback_idioma';

function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatearARS(n) {
  return '$' + Math.round(n).toLocaleString('es-AR');
}
function formatearUSD(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

// ---------- i18n ----------
function leerCookie(nombre) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${nombre}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
function guardarCookie(nombre, valor, dias) {
  const vence = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${nombre}=${encodeURIComponent(valor)}; expires=${vence}; path=/; SameSite=Lax`;
}

// Devuelve el texto de una key, con reemplazo simple de {variable} - si falta la key en el
// diccionario activo (texto sin traducir todavía, o typo), muestra la propia key en vez de
// romper la página, para que sea obvio en pantalla que falta completarla.
function t(key, vars = {}) {
  let texto = DICT[key] ?? key;
  for (const [k, v] of Object.entries(vars)) texto = texto.replace(`{${k}}`, v);
  return texto;
}

async function cargarDiccionario(idioma) {
  if (DICCIONARIOS_CACHE[idioma]) return DICCIONARIOS_CACHE[idioma];
  try {
    const res = await fetch(`/i18n/${idioma}.json`);
    if (!res.ok) throw new Error('no se pudo cargar');
    const data = await res.json();
    DICCIONARIOS_CACHE[idioma] = data;
    return data;
  } catch {
    // Si falla justo el idioma pedido (archivo roto, red caída a mitad de carga), español
    // es el fallback más seguro - es el idioma del mercado principal hoy.
    if (idioma !== 'es') return cargarDiccionario('es');
    return {};
  }
}

function aplicarTraducciones() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.title = t('meta_title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta_description'));
  document.getElementById('selector-idioma').value = IDIOMA;
}

async function cambiarIdioma(idioma, { guardar = true } = {}) {
  if (!IDIOMAS_SOPORTADOS.includes(idioma)) idioma = 'es';
  IDIOMA = idioma;
  DICT = await cargarDiccionario(idioma);
  if (guardar) guardarCookie(COOKIE_IDIOMA, idioma, 365);
  aplicarTraducciones();
  // Los planes tienen texto embebido en el HTML que arma el JS (nombre/descripción/
  // features, botones) - hay que volver a armarlos con el diccionario nuevo, no alcanza
  // con aplicarTraducciones() (que solo toca elementos [data-i18n] fijos del HTML).
  if (Object.keys(PLANES).length) {
    if (PAIS === 'AR') renderPlanesArgentina(); else renderPlanesInternacional();
  }
}

document.getElementById('selector-idioma').addEventListener('change', (e) => {
  cambiarIdioma(e.target.value);
});

// ---------- Planes + alta ----------
async function cargarPlanes() {
  // Pisa la detección por IP si la URL trae ?pais=otro (ver server/routes/public.js,
  // GET /geo) - solo para poder previsualizar la vista internacional (USD/Hotmart) desde
  // Argentina sin necesitar una VPN.
  const forzarPais = new URLSearchParams(window.location.search).get('pais');
  const geoUrl = forzarPais === 'otro' ? '/api/public/geo?pais=otro' : '/api/public/geo';

  const [resPlanes, resGeo] = await Promise.all([
    fetch('/api/public/planes'),
    fetch(geoUrl).catch(() => null)
  ]);
  const data = await resPlanes.json();
  PLANES = data.planes;
  HOTMART_LINKS = data.hotmart_links || {};

  let idiomaSugerido = 'es';
  if (resGeo && resGeo.ok) {
    const geoData = await resGeo.json();
    PAIS = geoData.pais || 'AR';
    idiomaSugerido = geoData.idioma_sugerido || 'es';
  }

  // La cookie (elección manual previa) pisa lo que sugiere la IP - solo se usa la
  // detección automática la primera vez que alguien entra. cambiarIdioma() ya renderiza
  // los planes al final (PLANES ya está seteado acá arriba), no hace falta repetirlo.
  const idiomaGuardado = leerCookie(COOKIE_IDIOMA);
  await cambiarIdioma(idiomaGuardado || idiomaSugerido, { guardar: false });
}

// nombre/descripción/features de cada plan viven en el diccionario de idioma (no en
// Mongo, que solo tiene el precio) - si un plan nuevo no está traducido todavía, cae al
// texto en español que sí manda la API, para no dejar la tarjeta vacía.
function textoPlan(id, p) {
  return DICT.planes?.[id] || { nombre: p.nombre, descripcion: p.descripcion, features: p.features };
}

function renderPlanesArgentina() {
  const cont = document.getElementById('planes');
  const select = document.getElementById('f-plan');
  const entradas = Object.entries(PLANES);

  cont.innerHTML = entradas.map(([id, p], i) => {
    const tx = textoPlan(id, p);
    return `
    <div class="pl-plan ${i === entradas.length - 1 ? 'destacado' : ''}">
      <div class="pl-plan-nombre">${esc(tx.nombre)}</div>
      <div class="pl-plan-precio"><span class="num">${formatearARS(p.precio_ars)}</span><span class="per">${t('plan_per_mes_ars', { usd: p.precio_usd_ref })}</span></div>
      <div class="pl-plan-desc">${esc(tx.descripcion)}</div>
      <ul>${tx.features.map((f) => `<li><i class="fa-solid fa-check"></i> ${esc(f)}</li>`).join('')}</ul>
      <button type="button" class="btn btn-primary" data-elegir="${esc(id)}" data-frecuencia="mensual">${t('plan_boton_mensual')}</button>

      <div class="pl-plan-anual">
        <span class="pl-plan-anual-badge"><i class="fa-solid fa-gift"></i> ${t('plan_badge_anual')}</span>
        <div class="pl-plan-anual-precio"><span class="num">${formatearARS(p.precio_ars_anual)}</span><span class="per">${t('plan_per_anio_ars', { usd: p.precio_usd_ref_anual })}</span></div>
        <button type="button" class="btn-ghost" data-elegir="${esc(id)}" data-frecuencia="anual" style="width: 100%;">${t('plan_boton_anual')}</button>
      </div>
    </div>
  `;
  }).join('');

  select.innerHTML = entradas.map(([id, p]) => `<option value="${esc(id)}">${esc(textoPlan(id, p).nombre)} — ${formatearARS(p.precio_ars)}${t('plan_select_sufijo')}</option>`).join('');

  cont.querySelectorAll('[data-elegir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      select.value = btn.dataset.elegir;
      document.getElementById('f-frecuencia').value = btn.dataset.frecuencia;
      actualizarPrecio();
      document.getElementById('f-nombre').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  actualizarPrecio();
}

// Sin formulario de alta acá - el botón ya es el link de pago, la cuenta se crea sola
// cuando se confirma la compra. Si algún plan todavía no tiene el link cargado (Hugo no
// terminó de armarlo en Hotmart), el botón queda deshabilitado en vez de llevar a un link
// roto.
function renderPlanesInternacional() {
  document.getElementById('pl-form-section').hidden = true;
  document.getElementById('trial-badge').innerHTML = `<i class="fa-solid fa-sparkles"></i> ${t('trial_badge_hotmart')}`;

  const cont = document.getElementById('planes');
  const entradas = Object.entries(PLANES);

  cont.innerHTML = entradas.map(([id, p], i) => {
    const tx = textoPlan(id, p);
    const links = HOTMART_LINKS[id] || {};
    const btn = (href, texto, clase) =>
      href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener" class="${clase}" style="text-align: center; text-decoration: none; display: block;">${texto}</a>`
        : `<button type="button" class="${clase}" disabled title="${esc(t('plan_boton_no_disponible'))}">${texto}</button>`;

    return `
      <div class="pl-plan ${i === entradas.length - 1 ? 'destacado' : ''}">
        <div class="pl-plan-nombre">${esc(tx.nombre)}</div>
        <div class="pl-plan-precio"><span class="num">${formatearUSD(p.precio_usd_ref)}</span><span class="per">${t('plan_per_mes_usd')}</span></div>
        <div class="pl-plan-desc">${esc(tx.descripcion)}</div>
        <ul>${tx.features.map((f) => `<li><i class="fa-solid fa-check"></i> ${esc(f)}</li>`).join('')}</ul>
        ${btn(links.mensual, t('plan_boton_mensual'), 'btn btn-primary')}

        <div class="pl-plan-anual">
          <span class="pl-plan-anual-badge"><i class="fa-solid fa-gift"></i> ${t('plan_badge_anual')}</span>
          <div class="pl-plan-anual-precio"><span class="num">${formatearUSD(p.precio_usd_ref_anual)}</span><span class="per">${t('plan_per_anio_usd')}</span></div>
          ${btn(links.anual, t('plan_boton_anual'), 'btn-ghost')}
        </div>
      </div>
    `;
  }).join('');
}

let codigoInfo = null;

function actualizarPrecio() {
  const plan = PLANES[document.getElementById('f-plan').value];
  if (!plan) return;
  const esAnual = document.getElementById('f-frecuencia').value === 'anual';
  const precioBase = esAnual ? plan.precio_ars_anual : plan.precio_ars;
  const periodo = t(esAnual ? 'unidad_anio' : 'unidad_mes');
  const el = document.getElementById('precio-final');
  if (codigoInfo && codigoInfo.valido) {
    const final = Math.round(precioBase * (1 - codigoInfo.descuento_pct / 100));
    el.innerHTML = `${t('precio_con_descuento')} <strong>${formatearARS(final)} ARS/${esc(periodo)}</strong> <span style="text-decoration: line-through; opacity: .6;">${formatearARS(precioBase)}</span>`;
  } else {
    el.textContent = '';
  }
}

document.getElementById('f-plan').addEventListener('change', actualizarPrecio);
document.getElementById('f-frecuencia').addEventListener('change', actualizarPrecio);

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
        status.textContent = t('codigo_valido', { pct: data.descuento_pct });
        status.className = 'pl-codigo-status ok';
      } else {
        status.textContent = t('codigo_invalido');
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
  status.textContent = t('form_creando');

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
        frecuencia: document.getElementById('f-frecuencia').value,
        codigo: document.getElementById('f-codigo').value.trim(),
        idioma: IDIOMA,
        _hp: document.getElementById('f-hp').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('form_error_generico'));
    window.location.href = '/tablero.html';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'form-status error';
  }
});

cargarPlanes().catch(() => {
  document.getElementById('planes').innerHTML = '<p class="loading">No se pudieron cargar los planes.</p>';
});
