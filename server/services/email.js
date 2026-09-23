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

async function enviarAutorespuesta({ nombreCliente, nombreDestinatario, emailDestinatario }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  const saludo = nombreDestinatario ? `Hola ${nombreDestinatario}` : 'Hola';

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Recibimos tu consulta - ${nombreCliente}`,
    html: `
      <p>${saludo},</p>
      <p>Gracias por escribirnos a <strong>${nombreCliente}</strong>. Ya recibimos tu consulta y en breve te vamos a contactar.</p>
      <p>Saludos,<br>${nombreCliente}</p>
    `
  });
}

module.exports = { enviarAutorespuesta };
