// Traducciones del panel del dueño del negocio (tablero, turnos, catálogo, etc.), en
// español / inglés / portugués. Es un sistema aparte del de la landing (planes.js): el
// idioma acá lo define el NEGOCIO (clientes.idioma) y llega por la cookie
// "frontyback_idioma" - la pone el servidor al loguearse (server/routes/auth.js) y se puede
// cambiar desde Configuración (PanelI18n.cambiarIdioma).
//
// Cada pantalla declara qué diccionarios necesita:
//   <script src="/js/panel-i18n.js" data-paginas="comun,tablero"></script>
// y se cargan /i18n/panel/<pagina>.<idioma>.json. El español es la base de todo: si falta
// una key en otro idioma, se muestra la del español, y recién después la key tal cual.
//
// Los diccionarios se piden de forma SINCRÓNICA a propósito: los scripts de cada pantalla
// arrancan en cuanto cargan (arman el tablero, piden datos) y necesitan tp() listo desde
// la primera línea. Son archivos chicos del mismo origen, así que el costo es mínimo.

(function () {
  const IDIOMAS = ['es', 'en', 'pt'];
  const COOKIE = 'frontyback_idioma';
  const LOCALES = { es: 'es-AR', en: 'en-US', pt: 'pt-BR' };

  function leerCookie(nombre) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${nombre}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function guardarCookie(nombre, valor, dias) {
    const vence = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${nombre}=${encodeURIComponent(valor)}; expires=${vence}; path=/; SameSite=Lax`;
  }

  const idioma = IDIOMAS.includes(leerCookie(COOKIE)) ? leerCookie(COOKIE) : 'es';

  function cargarDiccionario(pagina, lang) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/i18n/panel/${pagina}.${lang}.json`, false);
      xhr.send(null);
      if (xhr.status !== 200) return {};
      return JSON.parse(xhr.responseText);
    } catch {
      return {};
    }
  }

  const paginas = (document.currentScript?.dataset.paginas || 'comun').split(',').map((p) => p.trim());
  const DICT = {};
  const BASE = {};
  for (const pagina of paginas) {
    Object.assign(BASE, cargarDiccionario(pagina, 'es'));
    Object.assign(DICT, idioma === 'es' ? BASE : cargarDiccionario(pagina, idioma));
  }

  // tp('clave', { nombre: 'Ana' }) - reemplaza {nombre} en el texto.
  function tp(clave, vars = {}) {
    let texto = DICT[clave] ?? BASE[clave] ?? clave;
    for (const [k, v] of Object.entries(vars)) texto = texto.split(`{${k}}`).join(v);
    return texto;
  }

  // tpn('dias', 3) usa la clave "dias_uno" si n es 1, y "dias_otros" en cualquier otro caso
  // - lo justo para singular/plural sin armar un sistema de plurales completo. {n} se
  // reemplaza solo por el número.
  function tpn(clave, n, vars = {}) {
    return tp(`${clave}_${n === 1 ? 'uno' : 'otros'}`, { n, ...vars });
  }

  // Pinta los textos fijos del HTML que traen data-i18n (texto plano), data-i18n-html
  // (puede traer links o negritas - SOLO para keys de nuestros diccionarios, nunca para
  // nada que haya escrito un usuario), data-i18n-placeholder o data-i18n-title.
  function aplicar(raiz = document) {
    raiz.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tp(el.dataset.i18n); });
    raiz.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = tp(el.dataset.i18nHtml); });
    raiz.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = tp(el.dataset.i18nPlaceholder); });
    raiz.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = tp(el.dataset.i18nTitle); });
    document.documentElement.lang = idioma;
    if (DICT['pagina.titulo'] || BASE['pagina.titulo']) document.title = tp('pagina.titulo');
  }

  function cambiarIdioma(nuevo) {
    if (!IDIOMAS.includes(nuevo)) return;
    guardarCookie(COOKIE, nuevo, 365);
    window.location.reload();
  }

  const locale = LOCALES[idioma];

  window.PanelI18n = {
    idioma,
    locale,
    IDIOMAS,
    tp,
    tpn,
    aplicar,
    cambiarIdioma,
    guardarCookieIdioma: (l) => guardarCookie(COOKIE, l, 365),
    // Formatos según el idioma (antes estaba fijo 'es-AR' en cada pantalla).
    fecha: (iso, opciones) => (iso ? new Date(iso).toLocaleString(locale, opciones) : ''),
    fechaCorta: (iso) => (iso ? new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }) : ''),
    numero: (n) => Number(n).toLocaleString(locale)
  };
  window.tp = tp;
  window.tpn = tpn;

  // Los textos fijos del HTML se pintan apenas el DOM está listo.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => aplicar());
  else aplicar();
})();
