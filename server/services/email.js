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

// Avisos automáticos del ciclo de pagos: recordatorio antes de que termine la prueba
// gratis, aviso cuando arranca el período de gracia, y último aviso antes de que se corte
// el servicio del todo. Las tres mandan el mismo tipo de link de pago, solo cambia el
// apuro del mensaje.
const TEXTOS_AVISO_PAGO = {
  recordatorio_prueba: {
    asunto: 'Tu prueba gratis del CRM termina en 2 días',
    parrafo: 'Tu prueba gratis de 7 días en el CRM de FrontyBack está por terminar. Para que no se interrumpa el servicio, activá el pago acá abajo. Si ya lo programaste, ignorá este mensaje.'
  },
  inicio_gracia: {
    asunto: 'Tu plan venció - te quedan 7 días para reactivarlo',
    parrafo: 'Tu prueba gratis terminó y por ahora dejamos de mandar respuestas automáticas a tus consultas (las seguimos guardando igual, no se pierde nada). Tenés 7 días para reactivar el plan antes de que se corte del todo.'
  },
  ultimo_aviso: {
    asunto: 'Últimos días para reactivar tu CRM',
    parrafo: 'En pocos días se corta por completo tu servicio si no reactivás el pago. No vas a perder nada de lo que ya conseguiste, pero vas a dejar de recibir consultas nuevas hasta que pagues.'
  }
};

async function enviarAvisoPago({ emailDestinatario, tipo, link }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  const { asunto, parrafo } = TEXTOS_AVISO_PAGO[tipo];

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: asunto,
    html: `
      <p>Hola,</p>
      <p>${escHtml(parrafo)}</p>
      <p><a href="${escHtml(link)}" style="display:inline-block;background:#d4af37;color:#141517;font-weight:600;padding:10px 20px;border-radius:8px;text-decoration:none;">Activar el pago</a></p>
      <p>Saludos,<br>FrontyBack</p>
    `
  });
}

const ORIGEN_LABEL = {
  whatsapp_texto: 'WhatsApp',
  whatsapp_audio: 'WhatsApp (audio)',
  formulario: 'el formulario del sitio'
};

// Aviso al dueño del negocio cada vez que entra un lead NUEVO (no en cada mensaje de
// seguimiento de alguien que ya estaba en el tablero) - opcional, se apaga desde el
// tablero (cliente.avisos_lead_email) porque a un negocio con mucho volumen le termina
// resultando más un spam que una ayuda.
async function enviarAvisoLeadNuevo({ emailDestinatario, nombreCliente, nombreContacto, contacto, origen, mensaje }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  const quien = nombreContacto ? `${nombreContacto} (${contacto})` : contacto;
  const previewMensaje = String(mensaje || '').slice(0, 200);

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Nueva consulta por ${ORIGEN_LABEL[origen] || origen}`,
    html: `
      <p>Te llegó una consulta nueva a <strong>${escHtml(nombreCliente)}</strong>, por ${escHtml(ORIGEN_LABEL[origen] || origen)}.</p>
      <p><strong>De:</strong> ${escHtml(quien)}</p>
      <p><strong>Mensaje:</strong> "${escHtml(previewMensaje)}"</p>
      <p><a href="https://crm.frontyback.com/tablero.html" style="display:inline-block;background:#d4af37;color:#141517;font-weight:600;padding:10px 20px;border-radius:8px;text-decoration:none;">Ver en el tablero</a></p>
      <p style="color:#888;font-size:12px;">¿Te llegan demasiados avisos? Podés apagarlos desde el tablero.</p>
    `
  });
}

module.exports = { enviarAutorespuesta, enviarAvisoPago, enviarAvisoLeadNuevo };
