// Puntos de entrada públicos: acá llegan tanto los formularios de los sitios de los
// clientes como los mensajes de WhatsApp (vía el webhook que configura Meta).

const express = require('express');
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const asyncHandler = require('../asyncHandler');
const db = require('../db');
const fichas = require('../services/fichas');
const email = require('../services/email');
const whatsapp = require('../services/whatsapp');
const stt = require('../services/stt');
const tts = require('../services/tts');
const mercadopago = require('../services/mercadopago');

const router = express.Router();

// ---------- Formulario de contacto de los sitios de los clientes ----------
// Cualquier sitio de FrontyBack puede apuntar su formulario acá:
// POST /webhook/form/:slug  { nombre, email, mensaje }
// Es la única ruta pública sin ningún tipo de autenticación (cualquiera con la URL puede
// pegarle), así que es la que hay que blindar contra spam/bots antes de ofrecerla a clientes.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tope duro de tamaño del body - un formulario de contacto real nunca necesita más de
// esto, y evita que alguien mande payloads gigantes para saturar Mongo o los emails.
const parseFormBody = express.json({ limit: '15kb' });

// Como máximo 5 consultas cada 15 min por IP+cliente (una persona real jamás manda más
// que eso), y un tope más laxo por IP sola para que no se pueda rotar de cliente en
// cliente con la misma IP para esquivar el límite anterior.
const formLimiterPorCliente = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.params.slug}`,
  message: { error: 'Demasiadas consultas seguidas. Probá de nuevo en un rato.' }
});
const formLimiterGlobal = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas seguidas. Probá de nuevo en un rato.' }
});

router.post(
  '/form/:slug',
  formLimiterGlobal,
  formLimiterPorCliente,
  parseFormBody,
  asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const body = req.body || {};
    const nombre = String(body.nombre || '').trim().slice(0, 120);
    const emailCliente = String(body.email || '').trim().slice(0, 200);
    const mensaje = String(body.mensaje || '').trim().slice(0, 2000);

    // Campo trampa para bots: invisible para una persona (se oculta por CSS en el sitio
    // del cliente), así que si viene completo es un bot rellenando todos los inputs del
    // formulario. Respondemos 200 igual para no darle una pista de que lo detectamos.
    if (String(body._hp || '').trim()) {
      return res.json({ ok: true });
    }

    if (!emailCliente || !EMAIL_RE.test(emailCliente)) {
      return res.status(400).json({ error: 'El email no es válido.' });
    }

    const cliente = await db.getDb().collection('clientes').findOne({ slug });
    if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado.' });

    // Servicio cortado por falta de pago: no se guarda nada, pero no se lo decimos al
    // visitante del formulario (devolvemos 200 igual, es un tema entre nosotros y el cliente).
    if (!db.estadoPermiteCaptura(cliente.estado_pago)) {
      return res.json({ ok: true });
    }

    const columnaInicial = cliente.columnas[0].id;

    const ficha = await fichas.registrarConsulta({
      clienteId: cliente._id,
      columnaInicial,
      contacto: emailCliente,
      nombre,
      origen: 'formulario',
      mensaje
    });

    // En período de gracia (vencido, pero todavía dentro de los 7 días) seguimos
    // guardando la ficha para no perder el lead, pero no mandamos la respuesta automática -
    // esa es la parte del servicio que se corta primero.
    if (db.estadoPermiteRespuesta(cliente.estado_pago)) {
      try {
        const enviado = await email.enviarAutorespuesta({
          nombreCliente: cliente.nombre,
          nombreDestinatario: nombre,
          emailDestinatario: emailCliente
        });
        await fichas.registrarRespuesta(ficha._id, {
          canal: 'email',
          texto: `Asunto: ${enviado.asunto}\n\n${enviado.texto}`
        });
      } catch (err) {
        // No hacemos fallar el request por esto - la ficha ya quedó guardada, que es lo
        // importante; el email es un plus.
        console.error('No se pudo enviar la autorespuesta por email:', err.message);
      }
    }

    res.json({ ok: true });
  })
);

// ---------- WhatsApp Business Cloud API (Meta) ----------

// Defensa contra un ataque de saturación (cada request acá cuesta un cálculo HMAC): Meta
// jamás manda ráfagas así de grandes en uso normal, así que el límite es generoso a
// propósito para no interferir con tráfico real.
const whatsappLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
router.use('/whatsapp', whatsappLimiter);

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
  if (!db.estadoPermiteCaptura(cliente.estado_pago)) {
    return; // servicio cortado por falta de pago - no se procesa nada
  }
  const puedeResponder = db.estadoPermiteRespuesta(cliente.estado_pago);

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

      if (puedeResponder) {
        await whatsapp.enviarTexto({ phoneNumberId, para: waId, texto: MENSAJE_AUTORESPUESTA });
        await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_texto', texto: MENSAJE_AUTORESPUESTA });
      }
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

      if (puedeResponder) {
        const audioRespuesta = await tts.generarAudio(MENSAJE_AUTORESPUESTA);
        await whatsapp.enviarAudio({ phoneNumberId, para: waId, buffer: audioRespuesta });
        await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_audio', texto: MENSAJE_AUTORESPUESTA });
      }
    }
    // Otros tipos (imagen, ubicación, etc.) se ignoran por ahora - se puede sumar después.
  }
}

// ---------- Mercado Pago (cobro recurrente) ----------
// Mercado Pago avisa acá cada vez que cambia el estado de una suscripción (autorizada,
// cancelada) o se cobra una cuota. La URL se le pasa directamente a cada suscripción al
// crearla (notification_url, en server/services/mercadopago.js), así que no hace falta
// configurar nada aparte en el panel de Mercado Pago.

router.post(
  '/mercadopago',
  express.json(),
  asyncHandler(async (req, res) => {
    // Le contestamos 200 enseguida - si tarda o falla, Mercado Pago reintenta el mismo evento.
    res.sendStatus(200);

    try {
      await procesarNotificacionMercadoPago(req.body || {}, req.query || {});
    } catch (err) {
      console.error('Error procesando notificación de Mercado Pago:', err);
    }
  })
);

async function procesarNotificacionMercadoPago(body, query) {
  const tipo = body.type || query.type || query.topic;
  const id = body.data?.id || query.id || query['data.id'];
  if (!tipo || !id) return;

  if (tipo === 'subscription_preapproval') {
    const sus = await mercadopago.obtenerSuscripcion(id);
    const cliente = await db.getDb().collection('clientes').findOne({ slug: sus.external_reference });
    if (!cliente) return;

    if (sus.status === 'authorized') {
      await db.activarPorPago(cliente._id, { preapprovalId: sus.id });
    } else if (sus.status === 'cancelled') {
      await db.cortarPorFaltaDePago(cliente._id);
    }
  } else if (tipo === 'subscription_authorized_payment') {
    const pago = await mercadopago.obtenerPagoAutorizado(id);
    if (pago.status === 'approved' && pago.preapproval_id) {
      const cliente = await db.getDb().collection('clientes').findOne({ mercadopago_preapproval_id: pago.preapproval_id });
      if (cliente) await db.activarPorPago(cliente._id, { preapprovalId: pago.preapproval_id });
    }
  }
}

module.exports = router;
