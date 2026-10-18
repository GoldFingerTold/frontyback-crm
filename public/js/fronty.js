// Widget flotante de "Fronty" (asistente de IA en texto) - autocontenido, se incluye con
// un solo <script src="/js/fronty.js"> en cualquier página que ya tenga cargado css/style.css
// (usa sus variables de color). Mientras no exista el archivo /img/fronty.png todavía, cae
// a un emoji de respaldo - no hace falta tocar este archivo cuando se suba la imagen real.

(function () {
  const ESTILOS = `
    #fronty-btn {
      position: fixed; bottom: 22px; right: 22px; z-index: 9000;
      width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer;
      background: var(--bg-surface); border: 1px solid var(--border-subtle);
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
      padding: 0; overflow: hidden; transition: transform .2s ease;
    }
    #fronty-btn:hover { transform: scale(1.06); }
    #fronty-btn img { width: 100%; height: 100%; object-fit: cover; }
    #fronty-btn .fronty-fallback {
      display: none; width: 100%; height: 100%; align-items: center; justify-content: center;
      font-size: 26px; background: var(--accent-gold);
    }
    #fronty-panel {
      position: fixed; bottom: 92px; right: 22px; z-index: 9000;
      width: 340px; max-width: calc(100vw - 32px); height: 460px; max-height: calc(100vh - 140px);
      background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.45);
      display: none; flex-direction: column; overflow: hidden;
      font-family: 'Plus Jakarta Sans', sans-serif;
    }
    #fronty-panel.abierto { display: flex; }
    #fronty-head {
      display: flex; align-items: center; gap: 10px; padding: 14px 16px;
      border-bottom: 1px solid var(--border-subtle); flex: none;
    }
    #fronty-head .fh-avatar {
      width: 34px; height: 34px; border-radius: 50%; overflow: hidden; flex: none;
      background: var(--accent-gold); display: flex; align-items: center; justify-content: center;
    }
    #fronty-head .fh-avatar img { width: 100%; height: 100%; object-fit: cover; }
    #fronty-head .fh-texto { flex: 1; min-width: 0; }
    #fronty-head .fh-nombre { font-family: 'Clash Display', sans-serif; font-weight: 600; font-size: 14px; color: var(--text-primary); }
    #fronty-head .fh-sub { font-size: 11px; color: var(--text-muted); }
    #fronty-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 16px; padding: 4px; }
    #fronty-msgs { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .fronty-msg { font-size: 13px; line-height: 1.5; padding: 9px 12px; border-radius: 12px; max-width: 85%; white-space: pre-line; }
    .fronty-msg.bot { background: var(--bg-main); color: var(--text-secondary); align-self: flex-start; border: 1px solid var(--border-subtle); }
    .fronty-msg.user { background: var(--accent-gold); color: #141517; align-self: flex-end; font-weight: 500; }
    .fronty-msg.cargando { color: var(--text-muted); font-style: italic; }
    #fronty-form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border-subtle); flex: none; }
    #fronty-input {
      flex: 1; background: var(--bg-main); border: 1px solid var(--border-subtle); border-radius: 10px;
      padding: 9px 12px; color: var(--text-primary); font-size: 13px; font-family: inherit; outline: none;
    }
    #fronty-input:focus { border-color: rgba(212,175,55,0.4); }
    #fronty-send {
      flex: none; background: var(--accent-gold); color: #141517; border: none; border-radius: 10px;
      width: 38px; cursor: pointer; font-size: 14px;
    }
    #fronty-send:disabled { opacity: 0.6; cursor: default; }
  `;

  const AVATAR_HTML = `
    <img src="/img/fronty.png" alt="Fronty" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
    <span class="fronty-fallback" style="display:none;">🤖</span>
  `;

  const historial = [];

  function init() {
    const style = document.createElement('style');
    style.textContent = ESTILOS;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'fronty-btn';
    btn.type = 'button';
    btn.title = 'Preguntale a Fronty';
    btn.innerHTML = AVATAR_HTML;
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'fronty-panel';
    panel.innerHTML = `
      <div id="fronty-head">
        <div class="fh-avatar">${AVATAR_HTML}</div>
        <div class="fh-texto">
          <div class="fh-nombre">Fronty</div>
          <div class="fh-sub">Te ayuda a conectarte y resolver dudas</div>
        </div>
        <button type="button" id="fronty-close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="fronty-msgs"></div>
      <form id="fronty-form">
        <input type="text" id="fronty-input" placeholder="Escribí tu duda..." maxlength="500" autocomplete="off">
        <button type="submit" id="fronty-send"><i class="fa-solid fa-paper-plane"></i></button>
      </form>
    `;
    document.body.appendChild(panel);

    const msgs = document.getElementById('fronty-msgs');

    function agregarMensaje(texto, tipo) {
      const div = document.createElement('div');
      div.className = `fronty-msg ${tipo}`;
      div.textContent = texto;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    let saludoMostrado = false;
    btn.addEventListener('click', () => {
      panel.classList.toggle('abierto');
      if (panel.classList.contains('abierto') && !saludoMostrado) {
        agregarMensaje('¡Hola! Soy Fronty. Preguntame cómo conectar tu WhatsApp o cualquier duda del CRM.', 'bot');
        saludoMostrado = true;
      }
    });
    document.getElementById('fronty-close').addEventListener('click', () => panel.classList.remove('abierto'));

    document.getElementById('fronty-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('fronty-input');
      const pregunta = input.value.trim();
      if (!pregunta) return;

      agregarMensaje(pregunta, 'user');
      input.value = '';
      const sendBtn = document.getElementById('fronty-send');
      sendBtn.disabled = true;
      const cargando = agregarMensaje('Pensando...', 'bot cargando');

      try {
        const res = await fetch('/api/public/asistente', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pregunta, historial })
        });
        const data = await res.json();
        cargando.remove();
        if (!res.ok) throw new Error(data.error || 'No se pudo responder.');
        agregarMensaje(data.respuesta, 'bot');
        historial.push({ role: 'user', content: pregunta }, { role: 'assistant', content: data.respuesta });
      } catch (err) {
        cargando.remove();
        agregarMensaje(err.message, 'bot');
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
