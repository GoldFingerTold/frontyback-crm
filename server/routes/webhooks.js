// Puntos de entrada públicos: acá llegan tanto los formularios de los sitios de los
// clientes como los mensajes de WhatsApp (vía el webhook que configura Meta).

const express = require('express');
const crypto = require('crypto');
const asyncHandler = require('../asyncHandler');
const db = require('../db');
const fichas = require('../services/fichas');
const email = require('../services/email');
const whatsapp = require('../services/whatsapp');
const stt = require('../services/stt');
const tts = require('../services/tts');

const router = express.Router();

// ---------- Formulario de contacto de los sitios de los clientes ----------
// Cualquier sitio de FrontyBack puede apuntar su formulario acá:
// POST /webhook/form/:slug  { nombre, email, mensaje }

router.post('/form/:slug', express.json(), asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const { nombre, email: emailCliente, mensaje } = req.body || {};

  if (!emailCliente) return res.status(400).json({ error: 'Falta el email del contacto.' });

  const cliente = await db.getDb().collection('clientes').findOne({ slug });
  if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const columnaInicial = cliente.columnas[0].id;

  const ficha = await fichas.registrarConsulta({
    clienteId: cliente._id,
    columnaInicial,
    contacto: emailCliente,
    nombre,
    origen: 'formulario',
    mensaje: mensaje || ''
  });

  try {
    await email.enviarAutorespuesta({
      nombreCliente: cliente.nombre,
      nombreDestinatario: nombre,
      emailDestinatario: emailCliente
    });
    await fichas.registrarRespuesta(ficha._id, {
      canal: 'email',
      texto: 'Autorespuesta: recibimos tu consulta, en breve te vamos a contactar.'
    });
  } catch (err) {
    // No hacemos fallar el request por esto - la ficha ya quedó guardada, que es lo
    // importante; el email es un plus.
    console.error('No se pudo enviar la autorespuesta por email:', err.message);
  }

  res.json({ ok: true });
}));

// ---------- WhatsApp Business Cloud API (Meta) ----------

// Meta pide verificar el webhook con un GET antes de empezar a mandar eventos.
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Captura el body crudo (sin parsear) para poder verificar la firma de Meta antes de
// confiar en el contenido - cualquiera que sepa la URL podría mandar un POST fabricado
// si no se chequea esto.
function verificarFirmaMeta(req, res, buf) {
  req.rawBody = buf;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return; // si todavía no está configurado, se deja pasar en desarrollo

  const firmaRecibida = req.get('X-Hub-Signature-256');
  if (!firmaRecibida) throw new Error('Falta la firma de Meta en el request.');

  const firmaEsperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(buf).digest('hex');
  const iguales = crypto.timingSafeEqual(Buffer.from(firmaRecibida), Buffer.from(firmaEsperada));
  if (!iguales) throw new Error('La firma del webhook de WhatsApp no coincide.');
}

router.post(
  '/whatsapp',
  express.json({ verify: verificarFirmaMeta }),
  asyncHandler(async (req, res) => {
    // Le contestamos 200 a Meta enseguida - si tarda, Meta reintenta el mismo evento.
    res.sendStatus(200);

    try {
      await procesarEventoWhatsapp(req.body);
    } catch (err) {
      console.error('Error procesando mensaje de WhatsApp:', err);
    }
  })
);

const MENSAJE_AUTORESPUESTA = 'Recibimos tu consulta, en breve te vamos a contactar. ¡Gracias por escribirnos!';

async function procesarEventoWhatsapp(body) {
  const entry = body.entry?.[0];
  const cambio = entry?.changes?.[0]?.value;
  const mensajes = cambio?.messages;
  if (!mensajes || mensajes.length === 0) return; // puede ser un evento de "status" (entregado/leído), no un mensaje nuevo

  const phoneNumberId = cambio.metadata.phone_number_id;
  const cliente = await db.getDb().collection('clientes').findOne({ whatsapp_phone_number_id: phoneNumberId });
  if (!cliente) {
    console.warn(`Llegó un mensaje de WhatsApp para un número sin cliente asociado (phone_number_id=${phoneNumberId}).`);
    return;
  }

  const contactoInfo = cambio.contacts?.[0];
  const nombreContacto = contactoInfo?.profile?.name || '';
  const columnaInicial = cliente.columnas[0].id;

  for (const msg of mensajes) {
    const waId = msg.from;

    if (msg.type === 'text') {
      const texto = msg.text.body;
      const ficha = await fichas.registrarConsulta({
        clienteId: cliente._id,
        columnaInicial,
        contacto: waId,
        nombre: nombreContacto,
        origen: 'whatsapp_texto',
        mensaje: texto,
        whatsappWaId: waId
      });

      await whatsapp.enviarTexto({ phoneNumberId, para: waId, texto: MENSAJE_AUTORESPUESTA });
      await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_texto', texto: MENSAJE_AUTORESPUESTA });
    } else if (msg.type === 'audio') {
      const { buffer, mimeType } = await whatsapp.descargarMedia(msg.audio.id);

      let transcripcion = '(no se pudo transcribir el audio)';
      try {
        transcripcion = await stt.transcribirAudio(buffer, mimeType);
      } catch (err) {
        console.error('No se pudo transcribir el audio de WhatsApp:', err.message);
      }

      const ficha = await fichas.registrarConsulta({
        clienteId: cliente._id,
        columnaInicial,
        contacto: waId,
        nombre: nombreContacto,
        origen: 'whatsapp_audio',
        mensaje: transcripcion,
        whatsappWaId: waId
      });

      const audioRespuesta = await tts.generarAudio(MENSAJE_AUTORESPUESTA);
      await whatsapp.enviarAudio({ phoneNumberId, para: waId, buffer: audioRespuesta });
      await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_audio', texto: MENSAJE_AUTORESPUESTA });
    }
    // Otros tipos (imagen, ubicación, etc.) se ignoran por ahora - se puede sumar después.
  }
}

module.exports = router;
