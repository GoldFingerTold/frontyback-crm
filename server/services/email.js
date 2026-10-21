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
  formulario: 'el formulario del sitio',
  turno: 'una reserva de turno',
  meta_ads: 'una campaña de Meta Ads'
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

// Aviso para Hugo (no para el cliente) cuando el Embedded Signup de WhatsApp termina del
// lado de Meta pero algo impide terminar de registrarlo solo del lado del CRM - así no
// queda un cliente pensando que ya está conectado cuando en realidad falta un paso a mano.
async function enviarAvisoConexionManual({ nombreCliente, slug, motivo }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  const para = process.env.SUPERADMIN_NOTIFY_EMAIL || 'hugoceriani@gmail.com';

  await getResend().emails.send({
    from,
    to: para,
    subject: `Falta terminar a mano la conexión de WhatsApp de ${nombreCliente}`,
    html: `
      <p><strong>${escHtml(nombreCliente)}</strong> (usuario: ${escHtml(slug)}) terminó el Embedded Signup de WhatsApp
      del lado de Meta, pero el CRM no pudo registrar el número solo.</p>
      <p><strong>Motivo:</strong> ${escHtml(motivo)}</p>
      <p>Entrá al super-admin y agregá el número a mano (revisá los logs del servidor para ver qué devolvió Meta).</p>
    `
  });
}

async function enviarResumenSemanal({ emailDestinatario, nombreCliente, fichasNuevas, turnosNuevos, fidelidadNuevos }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Tu resumen de la semana en ${nombreCliente}`,
    html: `
      <p>Hola! Así te fue la última semana:</p>
      <ul>
        <li><strong>${fichasNuevas}</strong> consulta${fichasNuevas === 1 ? '' : 's'} nueva${fichasNuevas === 1 ? '' : 's'}</li>
        <li><strong>${turnosNuevos}</strong> turno${turnosNuevos === 1 ? '' : 's'} reservado${turnosNuevos === 1 ? '' : 's'}</li>
        <li><strong>${fidelidadNuevos}</strong> cliente${fidelidadNuevos === 1 ? '' : 's'} nuevo${fidelidadNuevos === 1 ? '' : 's'} en tu tarjeta de fidelización</li>
      </ul>
      <p><a href="https://crm.frontyback.com/tablero.html" style="display:inline-block;background:#d4af37;color:#141517;font-weight:600;padding:10px 20px;border-radius:8px;text-decoration:none;">Ver el tablero</a></p>
      <p style="color:#888;font-size:12px;">¿No te sirve este resumen? Lo podés apagar desde el tablero.</p>
    `
  });
}

// Aviso de fichas que llevan varios días sin novedades - un resumen agrupado (no un mail
// por ficha) para que no sea spam. Usa el mismo switch "avisos_lead_email" que el resto de
// los avisos del tablero, no uno aparte.
async function enviarAvisoFichasFrias({ emailDestinatario, nombreCliente, fichas }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `${fichas.length} consulta${fichas.length === 1 ? '' : 's'} sin avance en ${nombreCliente}`,
    html: `
      <p>Hola! Estas consultas llevan varios días sin novedades, puede que valga la pena hacer un seguimiento:</p>
      <ul>
        ${fichas.map((f) => `<li><strong>${escHtml(f.nombre)}</strong> - ${f.dias} día${f.dias === 1 ? '' : 's'} sin mensajes</li>`).join('')}
      </ul>
      <p><a href="https://crm.frontyback.com/tablero.html" style="display:inline-block;background:#d4af37;color:#141517;font-weight:600;padding:10px 20px;border-radius:8px;text-decoration:none;">Ver el tablero</a></p>
      <p style="color:#888;font-size:12px;">¿No te sirve este aviso? Lo podés apagar desde el tablero (mismo interruptor que los avisos de leads nuevos).</p>
    `
  });
}

// Alternativa sin costo al recordatorio por WhatsApp (que fuera de la ventana de 24hs se
// lo cobra Meta al dueño del negocio) - se manda solo si el cliente final cargó su email al
// reservar Y el negocio tiene prendido el switch de "recordatorio por email".
function formatearFechaTurno(fechaISO) {
  const [, mes, dia] = fechaISO.split('-');
  return `${dia}/${mes}`;
}

// linkGestion: turnos de antes de que existiera el token de gestión no lo tienen
// (server/db.js, crearTurno) - en ese caso no se incluye el botón, no hay nada que mostrar.
function botonGestion(linkGestion) {
  if (!linkGestion) return '';
  return `<p><a href="${escHtml(linkGestion)}" style="display:inline-block;background:rgba(212,175,55,0.12);color:#d4af37;font-weight:600;padding:9px 18px;border-radius:8px;text-decoration:none;font-size:13px;">Cancelar o cambiar mi turno</a></p>`;
}

async function enviarConfirmacionTurno({ emailDestinatario, nombreCliente, nombreContacto, servicioNombre, fecha, horaInicio, linkGestion }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Turno confirmado en ${nombreCliente}`,
    html: `
      <p>Hola ${escHtml(nombreContacto)}!</p>
      <p>Tu turno para <strong>${escHtml(servicioNombre)}</strong> en <strong>${escHtml(nombreCliente)}</strong> quedó confirmado para el ${escHtml(formatearFechaTurno(fecha))} a las ${escHtml(horaInicio)}hs.</p>
      ${botonGestion(linkGestion)}
      <p>Cualquier cambio, avisanos.</p>
    `
  });
}

async function enviarRecordatorioTurno({ emailDestinatario, nombreCliente, nombreContacto, servicioNombre, horaInicio, linkGestion }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';
  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Recordatorio: tu turno en ${nombreCliente} es mañana`,
    html: `
      <p>Hola ${escHtml(nombreContacto)}!</p>
      <p>Te recordamos tu turno para <strong>${escHtml(servicioNombre)}</strong> en <strong>${escHtml(nombreCliente)}</strong> mañana a las ${escHtml(horaInicio)}hs.</p>
      ${botonGestion(linkGestion)}
    `
  });
}

// Cuenta creada sola a partir de una compra en Hotmart (clientes fuera de Argentina) - a
// diferencia del alta por Mercado Pago, acá nadie eligió un usuario/contraseña a mano, así
// que es el único lugar donde el cliente se entera de sus credenciales.
async function enviarCredencialesHotmart({ emailDestinatario, nombreCliente, slug, password, nombrePlan }) {
  const from = process.env.RESEND_FROM_EMAIL || 'FrontyBack <no-reply@frontyback.com>';

  await getResend().emails.send({
    from,
    to: emailDestinatario,
    subject: `Tu cuenta del CRM FrontyBack está lista`,
    html: `
      <p>Hola!</p>
      <p>Gracias por tu compra del plan <strong>${escHtml(nombrePlan)}</strong>. Ya creamos tu cuenta del CRM de FrontyBack, lista para usar:</p>
      <p><strong>Usuario:</strong> ${escHtml(slug)}<br><strong>Contraseña:</strong> ${escHtml(password)}</p>
      <p><a href="https://crm.frontyback.com/login.html" style="display:inline-block;background:#d4af37;color:#141517;font-weight:600;padding:10px 20px;border-radius:8px;text-decoration:none;">Entrar al CRM</a></p>
      <p style="color:#888;font-size:12px;">Por seguridad, te recomendamos cambiar la contraseña la primera vez que entres.</p>
    `
  });
}

module.exports = {
  enviarAutorespuesta,
  enviarAvisoPago,
  enviarAvisoLeadNuevo,
  enviarAvisoConexionManual,
  enviarResumenSemanal,
  enviarConfirmacionTurno,
  enviarRecordatorioTurno,
  enviarAvisoFichasFrias,
  enviarCredencialesHotmart
};
