// Mensajes de WhatsApp para turnos (confirmación + recordatorio): ambos son proactivos
// (el negocio le escribe primero al cliente, no al revés), así que necesitan una plantilla
// aprobada por Meta y tienen costo - por eso van siempre contra el tope mensual del plan
// (server/db.js, maxTurnosMensajesDeCliente) antes de mandarse. Si no hay WhatsApp
// conectado, o se llegó al tope, el turno se guarda igual - el mensaje es un plus, no un
// requisito para que la reserva funcione.

const db = require('../db');
const whatsapp = require('./whatsapp');

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

async function intentarEnviar(cliente, { nombrePlantilla, parametros, para }) {
  const phoneNumberId = phoneNumberIdDeCliente(cliente);
  if (!phoneNumberId) return { enviado: false, motivo: 'sin_whatsapp' };

  const max = await db.maxTurnosMensajesDeCliente(cliente);
  const usados = await db.contarUsoTurnosEsteMes(cliente._id);
  if (usados >= max) return { enviado: false, motivo: 'tope_mensual' };

  try {
    await whatsapp.enviarPlantilla({ phoneNumberId, para, nombrePlantilla, parametros });
    await db.registrarUsoTurno(cliente._id);
    return { enviado: true };
  } catch (err) {
    console.error(`No se pudo mandar "${nombrePlantilla}" para el turno de ${cliente.slug}:`, err.message);
    return { enviado: false, motivo: 'error_envio' };
  }
}

async function enviarConfirmacion(cliente, turno) {
  return intentarEnviar(cliente, {
    nombrePlantilla: PLANTILLA_CONFIRMACION,
    para: turno.telefono_contacto,
    parametros: [turno.nombre_contacto, turno.servicio_nombre, formatearFecha(turno.fecha), turno.hora_inicio]
  });
}

async function enviarRecordatorio(cliente, turno) {
  return intentarEnviar(cliente, {
    nombrePlantilla: PLANTILLA_RECORDATORIO,
    para: turno.telefono_contacto,
    parametros: [turno.nombre_contacto, turno.servicio_nombre, turno.hora_inicio]
  });
}

// Da de alta las 2 plantillas de turnos en la WABA de un cliente apenas conecta su
// WhatsApp (Embedded Signup o carga manual del super-admin) - así Hugo no tiene que
// entrar a mano a Meta por cada cliente nuevo. Mejor esfuerzo: si falla, se loguea pero no
// rompe la conexión del número (la plantilla se puede crear después a mano si hace falta).
async function asegurarPlantillas(wabaId) {
  if (!wabaId) return;
  const intentos = [
    {
      nombre: PLANTILLA_CONFIRMACION,
      textoBody: 'Hola {{1}}! Tu turno para {{2}} quedó confirmado para el {{3}} a las {{4}}hs. Cualquier cambio, escribinos por acá.',
      ejemplos: ['Juan', 'Consulta', '15/10', '10:00']
    },
    {
      nombre: PLANTILLA_RECORDATORIO,
      textoBody: 'Hola {{1}}! Te recordamos tu turno para {{2}} mañana a las {{3}}hs.',
      ejemplos: ['Juan', 'Consulta', '10:00']
    }
  ];
  for (const plantilla of intentos) {
    try {
      await whatsapp.crearPlantilla({ wabaId, ...plantilla });
    } catch (err) {
      console.error(`No se pudo crear la plantilla "${plantilla.nombre}" en la WABA ${wabaId}:`, err.message);
    }
  }
}

module.exports = { enviarConfirmacion, enviarRecordatorio, asegurarPlantillas };
