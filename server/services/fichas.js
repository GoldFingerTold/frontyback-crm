// Lógica compartida para crear/actualizar una "ficha" (la tarjeta de un cliente en el
// tablero), sin importar si la consulta llegó por formulario o por WhatsApp. Una persona
// que escribe más de una vez no genera una ficha nueva cada vez - se busca primero por
// "contacto" (email o teléfono) dentro del mismo cliente, y si ya existe se le agrega el
// mensaje nuevo al historial en vez de duplicarla.

const db = require('../db');

// Al llegar una ficha nueva, entra siempre a la primera columna (la de "Nuevos"), al
// principio de la fila - "por orden de entrada" significa que la más vieja de las nuevas
// queda arriba, así el equipo la atiende primero.
async function siguientePosicion(clienteId, columnaId) {
  const mongo = db.getDb();
  const ultima = await mongo.collection('fichas')
    .find({ cliente_id: clienteId, columna_id: columnaId })
    .sort({ posicion: -1 })
    .limit(1)
    .toArray();
  return ultima.length > 0 ? ultima[0].posicion + 1 : 0;
}

// origen: 'formulario' | 'whatsapp_texto' | 'whatsapp_audio'
async function registrarConsulta({
  clienteId,
  columnaInicial,
  contacto,
  nombre,
  origen,
  mensaje,
  whatsappWaId
}) {
  const mongo = db.getDb();
  const ahora = new Date();

  const evento = {
    tipo: 'mensaje_entrante',
    origen,
    contenido: mensaje,
    fecha_hora: ahora
  };

  const existente = await mongo.collection('fichas').findOne({
    cliente_id: clienteId,
    contacto
  });

  if (existente) {
    await mongo.collection('fichas').updateOne(
      { _id: existente._id },
      {
        $set: {
          ultimo_mensaje: mensaje,
          ultimo_origen: origen,
          fecha_hora_ultimo_mensaje: ahora,
          ...(nombre ? { nombre } : {}),
          ...(whatsappWaId ? { whatsapp_wa_id: whatsappWaId } : {})
        },
        $push: { historial: evento }
      }
    );
    return { ...existente, _id: existente._id, esNueva: false };
  }

  const posicion = await siguientePosicion(clienteId, columnaInicial);
  const doc = {
    cliente_id: clienteId,
    nombre: nombre || '',
    contacto,
    whatsapp_wa_id: whatsappWaId || '',
    origen,
    mensaje,
    ultimo_mensaje: mensaje,
    ultimo_origen: origen,
    fecha_hora_recibido: ahora,
    fecha_hora_ultimo_mensaje: ahora,
    respuesta_enviada: null,
    columna_id: columnaInicial,
    posicion,
    historial: [evento]
  };
  const { insertedId } = await mongo.collection('fichas').insertOne(doc);
  return { ...doc, _id: insertedId, esNueva: true };
}

async function registrarRespuesta(fichaId, { canal, texto }) {
  const mongo = db.getDb();
  const ahora = new Date();
  await mongo.collection('fichas').updateOne(
    { _id: fichaId },
    {
      $set: {
        respuesta_enviada: { canal, texto, fecha_hora: ahora }
      },
      $push: {
        historial: { tipo: 'respuesta_saliente', canal, contenido: texto, fecha_hora: ahora }
      }
    }
  );
}

module.exports = { registrarConsulta, registrarRespuesta };
