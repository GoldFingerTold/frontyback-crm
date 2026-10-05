// Notificaciones push al navegador/celular (protocolo Web Push, estándar - no necesita
// Firebase ni ningún servicio de terceros). Se usan para avisar al instante cuando entra
// un lead nuevo, como upgrade del aviso por email (server/services/email.js) para quien
// instaló el CRM como PWA en el celular.

const webpush = require('web-push');

let configurado = false;
function asegurarConfigurado() {
  if (configurado) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    throw new Error('Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY en el .env.');
  }
  webpush.setVapidDetails('mailto:consulta@frontyback.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configurado = true;
}

// Manda la notificación a una suscripción puntual. Si el navegador ya no la reconoce
// (código 404/410 - el usuario desinstaló la PWA o borró los datos del sitio), avisa con
// "expirada: true" para que quien llama la borre de la base, en vez de seguir
// reintentando algo que nunca va a funcionar.
async function enviarPush(subscripcion, payload) {
  asegurarConfigurado();
  try {
    await webpush.sendNotification(
      { endpoint: subscripcion.endpoint, keys: subscripcion.keys },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    const expirada = err.statusCode === 404 || err.statusCode === 410;
    if (!expirada) console.error('Error mandando una notificación push:', err.message);
    return { ok: false, expirada };
  }
}

module.exports = { enviarPush };
