// Mensajes de WhatsApp para turnos (confirmación + recordatorio): ambos son proactivos
// (el negocio le escribe primero al cliente, no al revés), así que necesitan una plantilla
// aprobada por Meta y tienen costo. Ese costo lo paga el método de pago que el CLIENTE
// cargó en su propia cuenta de Meta Business Manager, no nosotros (cada WABA tiene su
// "messaging account" separada con su propia facturación) - por eso ya no cortamos el
// envío al llegar al tope del plan, solo lo registramos para mostrarlo como informativo
// (server/db.js, maxTurnosMensajesDeCliente/contarUsoTurnosEsteMes). Si el cliente todavía
// no cargó un método de pago, Meta devuelve el error 131042 al intentar mandar algo fuera
// de lo incluido - eso sí lo detectamos, para avisarle en el panel en vez de fallar en
// silencio. Si no hay WhatsApp conectado, el turno se guarda igual - el mensaje es un plus,
// no un requisito para que la reserva funcione.

const db = require('../db');
const whatsapp = require('./whatsapp');
const email = require('./email');

const PLANTILLA_CONFIRMACION = 'turno_confirmacion';
const PLANTILLA_RECORDATORIO = 'turno_recordatorio';

function formatearFecha(fechaISO) {
  const [, mes, dia] = fechaISO.split('-');
  return `${dia}/${mes}`;
}

// Devuelve el primer número de WhatsApp conectado del cliente, o null si no tiene
// ninguno todavía - los turnos igual se pueden reservar sin WhatsApp conectado.
function phoneNumberIdDeCliente(cliente) {
  return cliente.whatsapp_numeros?.[0]?.phone_number_id || null;
}

async function intentarEnviarWhatsapp(cliente, { nombrePlantilla, parametros, para }) {
  const phoneNumberId = phoneNumberIdDeCliente(cliente);
  if (!phoneNumberId) return { enviado: false, motivo: 'sin_whatsapp' };

  try {
    await whatsapp.enviarPlantilla({ phoneNumberId, para, nombrePlantilla, parametros, idioma: whatsapp.localeMeta(cliente.idioma) });
    await db.registrarUsoTurno(cliente._id);
    if (cliente.whatsapp_pago_pendiente) await db.marcarWhatsappPagoPendiente(cliente._id, false);
    return { enviado: true };
  } catch (err) {
    console.error(`No se pudo mandar "${nombrePlantilla}" para el turno de ${cliente.slug}:`, err.message);
    if (err.codigoMeta === 131042) {
      await db.marcarWhatsappPagoPendiente(cliente._id, true);
      return { enviado: false, motivo: 'pago_pendiente' };
    }
    return { enviado: false, motivo: 'error_envio' };
  }
}

// El email es la alternativa sin costo al WhatsApp - solo se manda si el negocio prendió
// el switch Y el cliente final cargó su email al reservar (el teléfono es obligatorio, el
// email no, así que puede no estar disponible aunque el switch esté prendido).
async function intentarEnviarEmail(cliente, turno, tipo) {
  if (!turno.email_contacto) return false;
  try {
    const datos = {
      emailDestinatario: turno.email_contacto,
      nombreCliente: cliente.nombre,
      nombreContacto: turno.nombre_contacto,
      servicioNombre: turno.servicio_nombre,
      horaInicio: turno.hora_inicio,
      linkGestion: turno.token_gestion ? `https://crm.frontyback.com/mi-turno.html?token=${turno.token_gestion}` : null
    };
    if (tipo === 'confirmacion') {
      await email.enviarConfirmacionTurno({ ...datos, fecha: turno.fecha });
    } else {
      await email.enviarRecordatorioTurno(datos);
    }
    return true;
  } catch (err) {
    console.error(`No se pudo mandar el email de "${tipo}" para el turno de ${cliente.slug}:`, err.message);
    return false;
  }
}

async function enviarConfirmacion(cliente, turno) {
  const config = await db.getTurnosConfig(cliente._id);
  if (config.recordatorio_whatsapp) {
    await intentarEnviarWhatsapp(cliente, {
      nombrePlantilla: PLANTILLA_CONFIRMACION,
      para: turno.telefono_contacto,
      parametros: [turno.nombre_contacto, turno.servicio_nombre, formatearFecha(turno.fecha), turno.hora_inicio]
    });
  }
  if (config.recordatorio_email) await intentarEnviarEmail(cliente, turno, 'confirmacion');
}

async function enviarRecordatorio(cliente, turno) {
  const config = await db.getTurnosConfig(cliente._id);
  let enviadoAlgo = false;

  if (config.recordatorio_whatsapp) {
    const resultado = await intentarEnviarWhatsapp(cliente, {
      nombrePlantilla: PLANTILLA_RECORDATORIO,
      para: turno.telefono_contacto,
      parametros: [turno.nombre_contacto, turno.servicio_nombre, turno.hora_inicio]
    });
    if (resultado.enviado) enviadoAlgo = true;
  }
  if (config.recordatorio_email && await intentarEnviarEmail(cliente, turno, 'recordatorio')) {
    enviadoAlgo = true;
  }

  // Si ningún canal está prendido (o el único que estaba prendido, el email, no tenía
  // destinatario), no hay nada para reintentar después - se marca como "procesado" igual,
  // si no el ciclo de recordatorios lo va a seguir intentando cada hora para siempre.
  const huboCanalDisponible = config.recordatorio_whatsapp || (config.recordatorio_email && turno.email_contacto);
  return { enviado: enviadoAlgo || !huboCanalDisponible };
}

// Textos de las 2 plantillas de turnos en los 3 idiomas que soporta la landing (público/
// i18n/) - se registran los 3 en cada WABA, y a la hora de mandar se elige según
// cliente.idioma (whatsapp.localeMeta, en intentarEnviarWhatsapp más arriba).
const TEXTOS_PLANTILLAS = {
  [PLANTILLA_CONFIRMACION]: {
    es_AR: { textoBody: 'Hola {{1}}! Tu turno para {{2}} quedó confirmado para el {{3}} a las {{4}}hs. Cualquier cambio, escribinos por acá.', ejemplos: ['Juan', 'Consulta', '15/10', '10:00'] },
    en_US: { textoBody: 'Hi {{1}}! Your appointment for {{2}} is confirmed for {{3}} at {{4}}. Message us here for any changes.', ejemplos: ['John', 'Consultation', '10/15', '10:00'] },
    pt_BR: { textoBody: 'Oi {{1}}! Seu horário para {{2}} foi confirmado para o dia {{3}} às {{4}}h. Qualquer mudança, é só chamar por aqui.', ejemplos: ['João', 'Consulta', '15/10', '10:00'] }
  },
  [PLANTILLA_RECORDATORIO]: {
    es_AR: { textoBody: 'Hola {{1}}! Te recordamos tu turno para {{2}} mañana a las {{3}}hs.', ejemplos: ['Juan', 'Consulta', '10:00'] },
    en_US: { textoBody: 'Hi {{1}}! Just a reminder: your appointment for {{2}} is tomorrow at {{3}}. See you then!', ejemplos: ['John', 'Consultation', '10:00'] },
    pt_BR: { textoBody: 'Oi {{1}}! Lembrando do seu horário para {{2}} amanhã às {{3}}h.', ejemplos: ['João', 'Consulta', '10:00'] }
  }
};

// Da de alta las plantillas de turnos (en los 3 idiomas) en la WABA de un cliente apenas
// conecta su WhatsApp (Embedded Signup o carga manual del super-admin) - así Hugo no tiene
// que entrar a mano a Meta por cada cliente nuevo. Mejor esfuerzo: si falla, se loguea pero
// no rompe la conexión del número (la plantilla se puede crear después a mano si hace
// falta). Idempotente - whatsapp.crearPlantilla no falla si la plantilla ya existe, así que
// también sirve para agregarle los idiomas nuevos a una WABA ya conectada antes.
async function asegurarPlantillas(wabaId) {
  if (!wabaId) return;
  for (const [nombre, porIdioma] of Object.entries(TEXTOS_PLANTILLAS)) {
    for (const [idioma, { textoBody, ejemplos }] of Object.entries(porIdioma)) {
      try {
        await whatsapp.crearPlantilla({ wabaId, nombre, idioma, textoBody, ejemplos });
      } catch (err) {
        console.error(`No se pudo crear la plantilla "${nombre}" (${idioma}) en la WABA ${wabaId}:`, err.message);
      }
    }
  }
}

module.exports = { enviarConfirmacion, enviarRecordatorio, asegurarPlantillas };
