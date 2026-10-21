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
const metaLeads = require('../services/metaLeads');
const stt = require('../services/stt');
const tts = require('../services/tts');
const mercadopago = require('../services/mercadopago');
const mercadopagoConnect = require('../services/mercadopagoConnect');
const hotmart = require('../services/hotmart');
const push = require('../services/push');
const turnosWhatsapp = require('../services/turnos');
const googleCalendar = require('../services/googleCalendar');

const router = express.Router();

const ORIGEN_LABEL_CORTO = { whatsapp_texto: 'WhatsApp', whatsapp_audio: 'WhatsApp (audio)', formulario: 'el formulario', turno: 'un turno', meta_ads: 'una campaña de Meta Ads' };

// Avisa por email y por notificación push (a quien instaló el CRM como PWA) al dueño del
// negocio cuando entra un lead NUEVO (no en cada mensaje de seguimiento). El email se
// apaga con cliente.avisos_lead_email (prendido por defecto); el push es opt-in por
// persona (solo le llega a quien se suscribió desde el tablero), y respeta el mismo
// filtro por departamento que el resto del tablero - a un empleado solo le avisa de los
// leads de su propio departamento, a Gerencia de todos. Nunca bloquea el flujo principal.
async function avisarLeadNuevo(cliente, ficha, { nombreContacto, contacto, origen, mensaje, departamento = null }) {
  if (!ficha.esNueva) return;

  if (cliente.avisos_lead_email && cliente.email_notificacion) {
    try {
      await email.enviarAvisoLeadNuevo({
        emailDestinatario: cliente.email_notificacion,
        nombreCliente: cliente.nombre,
        nombreContacto,
        contacto,
        origen,
        mensaje
      });
    } catch (err) {
      console.error('No se pudo mandar el aviso de lead nuevo:', err.message);
    }
  }

  try {
    const mongo = db.getDb();
    const suscripciones = await mongo.collection('push_subscriptions').find({ cliente_id: cliente._id }).toArray();
    if (suscripciones.length === 0) return;

    const payload = {
      title: `Nueva consulta por ${ORIGEN_LABEL_CORTO[origen] || origen}`,
      body: nombreContacto ? `${nombreContacto}: ${mensaje}`.slice(0, 120) : String(mensaje || '').slice(0, 120),
      url: '/tablero.html'
    };

    for (const sub of suscripciones) {
      const usuario = await mongo.collection('usuarios').findOne({ _id: sub.usuario_id });
      if (!usuario) continue;
      const leVale = usuario.rol === 'gerencia' || usuario.departamento === departamento;
      if (!leVale) continue;

      const resultado = await push.enviarPush(sub, payload);
      if (resultado.expirada) {
        await mongo.collection('push_subscriptions').deleteOne({ _id: sub._id });
      }
    }
  } catch (err) {
    console.error('No se pudo mandar la notificación push de lead nuevo:', err.message);
  }
}

// Crea la ficha en el tablero, avisa al negocio y manda la confirmación por WhatsApp/email
// de un turno - se llama apenas se reserva uno SIN seña (server/routes/public.js), o recién
// cuando se confirma el pago de uno CON seña (procesarNotificacionMercadoPagoTurno, más
// abajo). Vive acá (no en public.js) para poder usar avisarLeadNuevo sin un require
// circular entre los dos archivos.
async function confirmarYNotificarTurno(cliente, turno) {
  const conProfesional = turno.profesional_nombre ? `, con ${turno.profesional_nombre}` : '';
  const columnaInicial = cliente.columnas[0].id;
  const ficha = await fichas.registrarConsulta({
    clienteId: cliente._id,
    columnaInicial,
    contacto: turno.telefono_contacto,
    nombre: turno.nombre_contacto,
    origen: 'turno',
    mensaje: `Reservó: ${turno.servicio_nombre}${conProfesional}, ${turno.fecha} a las ${turno.hora_inicio}hs.`
  });
  await avisarLeadNuevo(cliente, ficha, {
    nombreContacto: turno.nombre_contacto,
    contacto: turno.telefono_contacto,
    origen: 'turno',
    mensaje: `Reservó ${turno.servicio_nombre}${conProfesional} para el ${turno.fecha} a las ${turno.hora_inicio}hs.`
  });

  await turnosWhatsapp.enviarConfirmacion(cliente, turno);

  // Mejor esfuerzo: si el cliente conectó Google Calendar, el turno también queda como
  // evento ahí. No bloquea la reserva si falla (token revocado, etc.) - el turno ya quedó
  // guardado en el CRM antes de llegar acá.
  googleCalendar.crearEventoTurno(cliente, turno).catch((err) =>
    console.error(`No se pudo crear el evento de Google Calendar para el turno de ${cliente.slug}:`, err.message)
  );
}

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
    await avisarLeadNuevo(cliente, ficha, { nombreContacto: nombre, contacto: emailCliente, origen: 'formulario', mensaje });

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

// Meta manda TODOS los eventos de esta app (WhatsApp, y ahora también los leads de Meta
// Ads) a esta misma URL de webhook - se distinguen por "object" en el body
// ("whatsapp_business_account" vs "page"), no hace falta una URL ni un token de
// verificación aparte por cada producto que se suscriba.
router.post(
  '/whatsapp',
  express.json({ verify: verificarFirmaMeta }),
  asyncHandler(async (req, res) => {
    // Le contestamos 200 a Meta enseguida - si tarda, Meta reintenta el mismo evento.
    res.sendStatus(200);

    try {
      if (req.body?.object === 'page') {
        await procesarEventoLeadgen(req.body);
      } else {
        await procesarEventoWhatsapp(req.body);
      }
    } catch (err) {
      console.error('Error procesando webhook de Meta:', err);
    }
  })
);

const MENSAJE_AUTORESPUESTA = 'Recibimos tu consulta, en breve te vamos a contactar. ¡Gracias por escribirnos!';

// Planes que incluyen WhatsApp con audio (transcripción + respuesta con voz) - Esencial no.
const PLANES_CON_AUDIO = ['completo', 'premium', 'elite'];

async function procesarEventoWhatsapp(body) {
  const entry = body.entry?.[0];
  const cambio = entry?.changes?.[0]?.value;
  const mensajes = cambio?.messages;
  if (!mensajes || mensajes.length === 0) {
    // Evento de "status" (enviado/entregado/leído/falló) en vez de un mensaje nuevo - se
    // loguean los que fallan, para poder ver por qué sin tener que adivinar.
    const statusesFallidos = (cambio?.statuses || []).filter((s) => s.status === 'failed');
    if (statusesFallidos.length) {
      console.error('Estado de mensaje de WhatsApp FALLIDO:', JSON.stringify(statusesFallidos));
      const esPorFaltaDePago = statusesFallidos.some((s) => s.errors?.some((e) => e.code === 131042));
      const phoneNumberId = cambio?.metadata?.phone_number_id;
      if (esPorFaltaDePago && phoneNumberId) {
        const cliente = await db.getDb().collection('clientes').findOne({ 'whatsapp_numeros.phone_number_id': phoneNumberId });
        if (cliente) await db.marcarWhatsappPagoPendiente(cliente._id, true);
      }
    }
    return;
  }

  const phoneNumberId = cambio.metadata.phone_number_id;
  const cliente = await db.getDb().collection('clientes').findOne({ 'whatsapp_numeros.phone_number_id': phoneNumberId });
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
  // De qué departamento es esta línea (si Hugo le puso etiqueta al conectarla) - define a
  // qué empleados se les muestra la ficha en server/routes/admin.js.
  const departamento = cliente.whatsapp_numeros.find((n) => n.phone_number_id === phoneNumberId)?.etiqueta || null;

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
        whatsappWaId: waId,
        phoneNumberId,
        departamento
      });
      await avisarLeadNuevo(cliente, ficha, { nombreContacto, contacto: waId, origen: 'whatsapp_texto', mensaje: texto, departamento });

      if (puedeResponder) {
        await whatsapp.enviarTexto({ phoneNumberId, para: waId, texto: MENSAJE_AUTORESPUESTA });
        await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_texto', texto: MENSAJE_AUTORESPUESTA });
      }
    } else if (msg.type === 'audio') {
      // Transcribir (OpenAI) y responder con voz (ElevenLabs) es lo único de este CRM que sale
      // directo del bolsillo de FrontyBack (nuestra propia API key, no la tarjeta del cliente
      // como pasa con WhatsApp) - por eso acá el tope mensual, proporcional al plan
      // (db.maxAudiosMesDeCliente), sí corta de verdad al llegar al límite. Fuera de eso igual
      // se guarda la consulta (no se pierde el lead), solo que sin transcribir y respondiendo
      // con el texto normal en vez de audio.
      const limiteAudios = await db.maxAudiosMesDeCliente(cliente);
      const usoActual = limiteAudios != null ? await db.contarUsoAudioEsteMes(cliente._id) : 0;
      const planIncluyeAudio = PLANES_CON_AUDIO.includes(cliente.plan);
      const puedeUsarAudio = planIncluyeAudio && (limiteAudios == null || usoActual < limiteAudios);

      let mensaje;
      if (puedeUsarAudio) {
        const { buffer, mimeType } = await whatsapp.descargarMedia(msg.audio.id);
        try {
          mensaje = await stt.transcribirAudio(buffer, mimeType);
        } catch (err) {
          console.error('No se pudo transcribir el audio de WhatsApp:', err.message);
          mensaje = '(no se pudo transcribir el audio)';
        }
        await db.registrarUsoAudio(cliente._id);
      } else {
        mensaje = planIncluyeAudio
          ? '(Audio recibido - se alcanzó el límite mensual de audios de esta cuenta)'
          : '(Audio recibido - el plan de esta cuenta no incluye transcripción automática)';
      }

      const ficha = await fichas.registrarConsulta({
        clienteId: cliente._id,
        columnaInicial,
        contacto: waId,
        nombre: nombreContacto,
        origen: 'whatsapp_audio',
        mensaje,
        whatsappWaId: waId,
        phoneNumberId,
        departamento
      });
      await avisarLeadNuevo(cliente, ficha, { nombreContacto, contacto: waId, origen: 'whatsapp_audio', mensaje, departamento });

      if (puedeResponder) {
        if (puedeUsarAudio) {
          const audioRespuesta = await tts.generarAudio(MENSAJE_AUTORESPUESTA);
          await whatsapp.enviarAudio({ phoneNumberId, para: waId, buffer: audioRespuesta });
          await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_audio', texto: MENSAJE_AUTORESPUESTA });
        } else {
          await whatsapp.enviarTexto({ phoneNumberId, para: waId, texto: MENSAJE_AUTORESPUESTA });
          await fichas.registrarRespuesta(ficha._id, { canal: 'whatsapp_texto', texto: MENSAJE_AUTORESPUESTA });
        }
      }
    }
    // Otros tipos (imagen, ubicación, etc.) se ignoran por ahora - se puede sumar después.
  }
}

// ---------- Meta Ads (leads de formularios instantáneos) ----------
async function procesarEventoLeadgen(body) {
  for (const entry of body.entry || []) {
    for (const cambio of entry.changes || []) {
      if (cambio.field !== 'leadgen') continue;
      const { leadgen_id: leadgenId, page_id: pageId } = cambio.value || {};
      if (!leadgenId || !pageId) continue;

      const cliente = await db.getDb().collection('clientes').findOne({ 'meta_pages.page_id': pageId });
      if (!cliente) {
        console.warn(`Llegó un lead de Meta Ads para una página sin cliente asociado (page_id=${pageId}).`);
        continue;
      }
      if (!db.estadoPermiteCaptura(cliente.estado_pago)) continue;

      const paginaInfo = cliente.meta_pages.find((p) => p.page_id === pageId);
      let lead;
      try {
        lead = await metaLeads.obtenerLead({ leadgenId, pageAccessToken: paginaInfo.page_access_token });
      } catch (err) {
        console.error(`No se pudo obtener el lead ${leadgenId} de Meta Ads:`, err.message);
        continue;
      }

      const { nombre, contacto, resumen } = metaLeads.mapearCamposLead(lead.field_data);
      if (!contacto) {
        console.warn(`Lead de Meta Ads ${leadgenId} sin teléfono ni email reconocible, se guarda igual con lo que mandó:`, JSON.stringify(lead.field_data));
      }

      const columnaInicial = cliente.columnas[0].id;
      const ficha = await fichas.registrarConsulta({
        clienteId: cliente._id,
        columnaInicial,
        contacto: contacto || `lead-${leadgenId}`,
        nombre,
        origen: 'meta_ads',
        mensaje: resumen
      });
      await avisarLeadNuevo(cliente, ficha, { nombreContacto: nombre, contacto: contacto || nombre, origen: 'meta_ads', mensaje: resumen });
    }
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

// ---------- Mercado Pago (seña de Turnos, cuenta propia de cada negocio) ----------
// Distinto del webhook de arriba: ese usa el token GLOBAL de FrontyBack (cobro de la
// suscripción del CRM); este usa el token de CADA cliente (server/services/
// mercadopagoConnect.js) para cobrar la seña de un turno a nombre del propio negocio. El
// webhook en sí nunca dice si el pago es real - siempre hay que volver a consultarlo
// contra la API con el token correcto antes de confirmar nada.
router.post(
  '/mercadopago-turno',
  express.json(),
  asyncHandler(async (req, res) => {
    res.sendStatus(200);
    try {
      await procesarNotificacionMercadoPagoTurno(req.body || {}, req.query || {});
    } catch (err) {
      console.error('Error procesando notificación de Mercado Pago (seña de turno):', err);
    }
  })
);

async function procesarNotificacionMercadoPagoTurno(body, query) {
  const tipo = body.type || query.type || query.topic;
  const paymentId = body.data?.id || query.id || query['data.id'];
  const turnoId = query.turno_id;
  if (tipo !== 'payment' || !paymentId || !turnoId) return;

  const mongo = db.getDb();
  const turno = await mongo.collection('turnos').findOne({ _id: new db.ObjectId(turnoId) });
  if (!turno || turno.estado !== 'pendiente_pago') return; // ya confirmado, cancelado, o no existe

  const cliente = await mongo.collection('clientes').findOne({ _id: turno.cliente_id });
  if (!cliente) return;

  // El webhook solo avisa "pasó algo" - nunca hay que confiar en eso sin volver a
  // consultar el pago con el access_token del propio negocio antes de confirmar nada.
  const pago = await mercadopagoConnect.obtenerPago(cliente, paymentId);
  if (pago.status !== 'approved') return;

  const confirmadoAhora = await db.confirmarTurnoPagado(turno._id);
  if (!confirmadoAhora) return; // reintento del mismo webhook, ya se había avisado antes

  await confirmarYNotificarTurno(cliente, { ...turno, estado: 'confirmado' });
}

// ---------- Hotmart (suscripción de clientes internacionales, fuera de Argentina) ----------
// Mismo propósito que el webhook de Mercado Pago de arriba (activar/cortar la suscripción
// del CRM), pero para los que compran afuera: Hugo vende los 4 planes como productos de
// Hotmart, con el período de prueba manejado del lado de Hotmart (con tarjeta) - acá solo
// reaccionamos a sus eventos. A diferencia de Mercado Pago, la cuenta NO existe de antes
// (nadie pasó por el formulario de alta de FrontyBack): la primera compra aprobada CREA la
// cuenta sola y le manda las credenciales por email (server/services/email.js,
// enviarCredencialesHotmart).
router.post(
  '/hotmart',
  express.json(),
  asyncHandler(async (req, res) => {
    res.sendStatus(200);
    try {
      await procesarNotificacionHotmart(req.body || {}, req.query || {});
    } catch (err) {
      console.error('Error procesando notificación de Hotmart:', err);
    }
  })
);

// Nombres de evento documentados por Hotmart para "se aprobó la compra" y "se dio de baja"
// - sin confirmar todavía contra un webhook real (ver server/services/hotmart.js).
const EVENTOS_HOTMART_APROBADO = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];
const EVENTOS_HOTMART_BAJA = ['PURCHASE_CANCELED', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'SUBSCRIPTION_CANCELLATION'];

function generarSlugDesdeNombre(nombre) {
  return (
    String(nombre || 'cliente')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cliente'
  );
}

async function generarSlugUnico(nombre) {
  const mongo = db.getDb();
  const base = generarSlugDesdeNombre(nombre);
  let slug = base;
  let i = 1;
  while (await mongo.collection('clientes').findOne({ slug })) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

async function procesarNotificacionHotmart(body, query) {
  if (!hotmart.hottokValido(body, query)) {
    console.warn('Webhook de Hotmart con Hottok inválido o ausente - ignorado.');
    return;
  }

  const datos = hotmart.extraerDatosCompra(body);
  if (!datos.evento) {
    console.warn('Webhook de Hotmart sin evento reconocible, payload completo:', JSON.stringify(body));
    return;
  }

  const mongo = db.getDb();

  if (EVENTOS_HOTMART_APROBADO.includes(datos.evento)) {
    if (!datos.email) {
      console.error('Compra aprobada de Hotmart sin email de comprador, payload completo:', JSON.stringify(body));
      return;
    }

    const existente = await mongo.collection('clientes').findOne({ email_notificacion: datos.email, pasarela_pago: 'hotmart' });
    if (existente) {
      // Renovación o reintento del mismo evento - la cuenta ya existe, solo nos aseguramos
      // de que siga activa (p.ej. si había entrado en gracia por un pago anterior fallido).
      await db.activarPorPago(existente._id, {});
      return;
    }

    const planes = await db.getPlanes();
    const identificado = hotmart.identificarPlanPorMonto(datos.monto, planes);
    if (!identificado) {
      console.error(`No se pudo identificar qué plan se compró en Hotmart (monto=${datos.monto}, moneda=${datos.moneda}) - payload completo:`, JSON.stringify(body));
      return;
    }

    const plan = planes[identificado.planId];
    const slug = await generarSlugUnico(datos.nombre || datos.email.split('@')[0]);
    const password = crypto.randomBytes(9).toString('base64url');
    const precio = identificado.frecuencia === 'anual' ? plan.precio_ars_anual : plan.precio_ars;

    const cliente = await db.crearCliente({
      slug,
      nombre: datos.nombre || slug,
      email_notificacion: datos.email,
      admin_password: password,
      plan: identificado.planId,
      precio_pactado: precio,
      frecuencia_pago: identificado.frecuencia,
      origen: 'hotmart',
      pasarela_pago: 'hotmart',
      hotmart_data: { transaccion: datos.transaccion, subscriber_code: datos.subscriberCode, monto: datos.monto, moneda: datos.moneda }
    });

    try {
      await email.enviarCredencialesHotmart({
        emailDestinatario: datos.email,
        nombreCliente: cliente.nombre,
        slug,
        password,
        nombrePlan: plan.nombre
      });
    } catch (err) {
      console.error(`No se pudo mandar las credenciales a ${datos.email} (la cuenta "${slug}" quedó creada igual):`, err.message);
    }

    console.log(`Cuenta nueva creada vía Hotmart: "${slug}" (plan ${identificado.planId}, ${identificado.frecuencia}).`);
  } else if (EVENTOS_HOTMART_BAJA.includes(datos.evento)) {
    const filtro = datos.subscriberCode
      ? { 'hotmart_data.subscriber_code': datos.subscriberCode }
      : { email_notificacion: datos.email, pasarela_pago: 'hotmart' };
    const cliente = await mongo.collection('clientes').findOne(filtro);
    if (!cliente) {
      console.warn(`Baja de Hotmart sin cliente identificable (email="${datos.email}", subscriber_code="${datos.subscriberCode}").`);
      return;
    }
    await db.cortarPorFaltaDePago(cliente._id);
  } else {
    console.log(`Evento de Hotmart no manejado ("${datos.evento}"), se ignora.`);
  }
}

module.exports = router;
module.exports.avisarLeadNuevo = avisarLeadNuevo;
module.exports.confirmarYNotificarTurno = confirmarYNotificarTurno;
module.exports.procesarNotificacionHotmart = procesarNotificacionHotmart;
