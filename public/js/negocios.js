// Selector de negocio del panel (plan Elite): una cuenta puede tener varios negocios o
// emprendimientos, cada uno con su propio tablero, WhatsApp, turnos, catálogo y fidelidad.
// Se muestra solo si el servidor dice que la cuenta lo tiene habilitado (GET /api/auth/negocios);
// en cualquier otro plan no aparece nada. Se incluye en todas las pantallas del panel, después
// de panel-i18n.js, y se engancha debajo del logo del menú lateral.
(function () {
  const marca = document.querySelector('aside .brand-container');
  if (!marca) return;

  function texto(clave, vars) {
    return typeof window.tp === 'function' ? window.tp(clave, vars) : clave;
  }

  function esc(valor) {
    return String(valor).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function slugDe(nombre) {
    return nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  async function pedir(url, cuerpo) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Error');
    return data;
  }

  const estilos = document.createElement('style');
  estilos.textContent = `
    .negocio-box { margin: -6px 0 18px; padding: 0 8px; }
    .negocio-box label { display: block; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; }
    .negocio-box select { width: 100%; padding: 9px 10px; border-radius: 9px; background: var(--bg-chip); color: var(--text-primary); border: 1px solid var(--border-subtle); font: inherit; font-size: 13px; }
    .negocio-box select:focus-visible, .negocio-box button:focus-visible, .negocio-dialogo :is(input, button):focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 1px; }
    .negocio-box .negocio-mas { width: 100%; margin-top: 8px; padding: 8px 10px; border-radius: 9px; background: transparent; color: var(--accent-gold); border: 1px dashed var(--accent-gold); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .negocio-box .negocio-cupo { margin: 8px 0 0; font-size: 11px; color: var(--text-muted); }
    .negocio-dialogo { border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--bg-surface); color: var(--text-primary); padding: 22px; width: min(420px, calc(100vw - 32px)); }
    .negocio-dialogo::backdrop { background: rgba(0, 0, 0, .6); }
    .negocio-dialogo h3 { margin: 0 0 14px; font-size: 16px; }
    .negocio-dialogo label { display: block; font-size: 12px; color: var(--text-secondary); margin: 12px 0 5px; }
    .negocio-dialogo input { width: 100%; padding: 10px 12px; border-radius: 9px; background: var(--bg-main); color: var(--text-primary); border: 1px solid var(--border-subtle); font: inherit; }
    .negocio-dialogo small { display: block; margin-top: 5px; color: var(--text-muted); font-size: 11px; }
    .negocio-dialogo .negocio-error { color: var(--danger); font-size: 13px; margin-top: 10px; }
    .negocio-dialogo .negocio-botones { display: flex; gap: 8px; margin-top: 18px; justify-content: flex-end; }
    .negocio-dialogo button { padding: 9px 14px; border-radius: 9px; border: 1px solid var(--border-subtle); background: transparent; color: var(--text-secondary); font: inherit; font-weight: 600; cursor: pointer; }
    .negocio-dialogo button[type="submit"] { background: var(--accent-gold); border-color: var(--accent-gold); color: #1a1405; }
    .negocio-dialogo button:disabled { opacity: .6; cursor: wait; }
  `;
  document.head.appendChild(estilos);

  function abrirDialogo() {
    const dlg = document.createElement('dialog');
    dlg.className = 'negocio-dialogo';
    dlg.innerHTML = `
      <form method="dialog" novalidate>
        <h3>${esc(texto('negocio.nuevo_titulo'))}</h3>
        <label for="neg-nombre">${esc(texto('negocio.nombre'))}</label>
        <input id="neg-nombre" maxlength="80" autocomplete="off" placeholder="${esc(texto('negocio.nombre_ej'))}">
        <label for="neg-slug">${esc(texto('negocio.slug'))}</label>
        <input id="neg-slug" maxlength="40" autocomplete="off" spellcheck="false" placeholder="${esc(texto('negocio.slug_ej'))}">
        <small>${esc(texto('negocio.slug_ayuda'))}</small>
        <div class="negocio-error" role="alert" hidden></div>
        <div class="negocio-botones">
          <button type="button" data-cancelar>${esc(texto('comun.cancelar'))}</button>
          <button type="submit">${esc(texto('negocio.crear'))}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const nombre = dlg.querySelector('#neg-nombre');
    const slug = dlg.querySelector('#neg-slug');
    const error = dlg.querySelector('.negocio-error');
    const enviar = dlg.querySelector('button[type="submit"]');
    let slugTocado = false;
    slug.addEventListener('input', () => { slugTocado = true; });
    nombre.addEventListener('input', () => { if (!slugTocado) slug.value = slugDe(nombre.value); });
    dlg.querySelector('[data-cancelar]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true; enviar.disabled = true;
      try {
        await pedir('/api/auth/negocios', { nombre: nombre.value, slug: slug.value });
        window.location.href = '/tablero.html';
      } catch (err) {
        error.textContent = texto('negocio.error', { mensaje: err.message });
        error.hidden = false; enviar.disabled = false;
      }
    });
    dlg.showModal();
    nombre.focus();
  }

  fetch('/api/auth/negocios').then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (!data || !data.habilitado) return;
    const caja = document.createElement('div');
    caja.className = 'negocio-box';
    const opciones = data.negocios
      .map((n) => `<option value="${esc(n.id)}"${n.id === data.activoId ? ' selected' : ''}>${esc(n.nombre)}</option>`).join('');
    caja.innerHTML = `
      <label for="negocio-select">${esc(texto('negocio.titulo'))}</label>
      <select id="negocio-select">${opciones}</select>
      ${data.puedeCrear
        ? `<button type="button" class="negocio-mas">${esc(texto('negocio.agregar'))}</button>`
        : `<p class="negocio-cupo">${esc(texto('negocio.cupo', { max: data.max }))}</p>`}`;
    marca.insertAdjacentElement('afterend', caja);

    caja.querySelector('#negocio-select').addEventListener('change', async (e) => {
      e.target.disabled = true;
      try {
        await pedir('/api/auth/negocios/cambiar', { id: e.target.value });
        window.location.reload();
      } catch (err) {
        e.target.disabled = false;
        e.target.value = data.activoId;
        alert(texto('negocio.error', { mensaje: err.message }));
      }
    });
    const mas = caja.querySelector('.negocio-mas');
    if (mas) mas.addEventListener('click', abrirDialogo);
  }).catch(() => {});
})();
