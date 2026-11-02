// Responde por email desde la ficha, con la misma casilla que lee correo-entrante.js
// (IMAP_USER / IMAP_PASS). Así, si la persona contesta, su respuesta vuelve a entrar sola
// a la misma ficha. Solo está disponible para el negocio IMAP_SLUG (por defecto Fronty).

const nodemailer = require('nodemailer');

let transporte = null;

function config() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) return null;
  return { user, pass, slug: process.env.IMAP_SLUG || 'crm-frontyback', host: process.env.SMTP_HOST || 'smtp.hostinger.com', port: Number(process.env.SMTP_PORT) || 465 };
}

// ¿Este negocio tiene casilla conectada para responder?
function disponiblePara(cliente) {
  const cfg = config();
  return Boolean(cfg && cliente && cliente.slug === cfg.slug);
}

// El asunto de la consulta viene en la primera línea del mensaje guardado: "Email: <asunto>"
function asuntoDeLaFicha(ficha) {
  const m = String(ficha.ultimo_mensaje || ficha.mensaje || '').match(/^Email: (.+)/);
  const base = m ? m[1].trim() : '';
  if (!base) return 'Respuesta de FrontyBack';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

async function enviarRespuesta({ ficha, texto, nombreRemitente = 'FrontyBack' }) {
  const cfg = config();
  if (!cfg) throw new Error('No hay una casilla de correo conectada.');
  if (!transporte) {
    transporte = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: { user: cfg.user, pass: cfg.pass } });
  }
  const asunto = asuntoDeLaFicha(ficha);
  await transporte.sendMail({
    from: `"${nombreRemitente}" <${cfg.user}>`,
    to: ficha.contacto,
    replyTo: cfg.user,
    subject: asunto,
    text: texto
  });
  return { asunto };
}

module.exports = { disponiblePara, enviarRespuesta };
