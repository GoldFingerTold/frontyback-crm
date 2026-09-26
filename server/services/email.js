// Autorespuesta por email cuando llega una consulta por formulario. Mismo servicio
// (Resend) que ya se usa en los sitios de los clientes.

const { Resend } = require('resend');

let resend = null;
function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) throw new Error('Falta RESEND_API_KEY en el .env.');
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

function escHtml(valor) {
  return String(valor).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function enviarAutorespuesta({ nombreCliente, nombreDestinatario, emailDestinatario }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  const saludo = nombreDestinatario ? `Hola ${nombreDestinatario}` : 'Hola';

  const asunto = `Recibimos tu consulta - ${nombreCliente}`;
  const parrafo = `Gracias por escribirnos a ${nombreCliente}. Ya recibimos tu consulta y en breve te vamos a contactar.`;

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: asunto,
    html: `
      <p>${escHtml(saludo)},</p>
      <p>Gracias por escribirnos a <strong>${escHtml(nombreCliente)}</strong>. Ya recibimos tu consulta y en breve te vamos a contactar.</p>
      <p>Saludos,<br>${escHtml(nombreCliente)}</p>
    `
  });

  return { asunto, texto: `${saludo},\n\n${parrafo}\n\nSaludos,\n${nombreCliente}` };
}

module.exports = { enviarAutorespuesta };
