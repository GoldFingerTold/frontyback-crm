// Alta por autoservicio desde la landing de ventas (index.html): cualquiera puede
// anotarse eligiendo un plan, con 7 días de prueba gratis. Es la única ruta pública que
// crea cuentas, así que lleva el mismo blindaje que el formulario de contacto del
// webhook (límite de envíos, honeypot, validación real) - ver server/routes/webhooks.js.

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const email = require('../services/email');
const fichas = require('../services/fichas');
const turnosWhatsapp = require('../services/turnos');
const whatsapp = require('../services/whatsapp');
const asistente = require('../services/asistente');
const metaLeads = require('../services/metaLeads');
const mercadopagoConnect = require('../services/mercadopagoConnect');
const hotmart = require('../services/hotmart');
const geoip = require('geoip-lite');
const { avisarLeadNuevo, confirmarYNotificarTurno } = require('./webhooks');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Demasiados intentos de alta seguidos. Probá de nuevo más tarde.' }
});

// "Fronty" no requiere login (tiene que poder ayudar desde la pantalla de conexión de
// WhatsApp, antes de que el cliente entre al tablero) - como consume OpenAI con costo real
// por consulta, lleva su propio límite para no quedar expuesto a que alguien lo use de boca
// de spam gratis.
const asistenteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Demasiadas preguntas seguidas. Probá de nuevo en un rato, o escribinos por WhatsApp.' }
});

router.post('/asistente', asistenteLimiter, asyncHandler(async (req, res) => {
  const pregunta = String(req.body?.pregunta || '').trim().slice(0, 500);
  if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta.' });

  const historialCrudo = Array.isArray(req.body?.historial) ? req.body.historial : [];
  const historial = historialCrudo
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }))
    .slice(-6);

  try {
    const respuesta = await asistente.responder(pregunta, historial);
    res.json({ respuesta });
  } catch (err) {
    console.error('Error en el asistente Fronty:', err.message);
    res.status(500).json({ error: 'Fronty no pudo responder ahora. Probá de nuevo o escribinos por WhatsApp.' });
  }
}));

router.get('/planes', asyncHandler(async (req, res) => {
  const planes = await db.getPlanes();
  res.json({ planes, dias_prueba: db.DIAS_PRUEBA_GRATIS, hotmart_links: hotmart.linksDeCheckout() });
}));

// Detecta de qué país viene el visitante (para que la landing muestre precios en ARS vía
// Mercado Pago a Argentina, y en USD vía Hotmart a cualquier otro país - public/js/
// planes.js). "trust proxy" ya está configurado en server/index.js, así que req.ip es la
// IP real del visitante y no la del proxy de nginx delante del servidor.
router.get('/geo', (req, res) => {
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  const geo = geoip.lookup(ip);
  res.json({ pais: geo?.country === 'AR' ? 'AR' : 'otro' });
});

// Validación "en vivo" del código mientras el visitante lo escribe en el formulario, para
// mostrarle de una el descuento antes de mandar el alta.
router.get('/codigos/:codigo', asyncHandler(async (req, res) => {
  const codigo = String(req.params.codigo || '').trim().toUpperCase();
  if (!codigo) return res.status(400).json({ valido: false });
  const doc = await db.getDb().collection('codigos').findOne({ codigo, activo: true });
  if (!doc) return res.json({ valido: false });
  if (doc.usos_maximos !== null && doc.usos_maximos !== undefined && doc.usos_actuales >= doc.usos_maximos) {
    return res.json({ valido: false });
  }
  res.json({ valido: true, descuento_pct: doc.descuento_pct });
}));

router.post(
  '/signup',
  signupLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};

    // Honeypot: igual que en el formulario de contacto, un campo invisible para personas.
    if (String(body._hp || '').trim()) {
      return res.json({ ok: true });
    }

    const nombre = String(body.nombre || '').trim().slice(0, 120);
    const slug = String(body.slug || '').trim().toLowerCase();
    const email = String(body.email || '').trim().slice(0, 200);
    const password = String(body.password || '');
    const planId = String(body.plan || '');
    const frecuencia = body.frecuencia === 'anual' ? 'anual' : 'mensual';
    const codigoTexto = String(body.codigo || '').trim().toUpperCase();

    if (!nombre || !slug || !email || !password) {
      return res.status(400).json({ error: 'Faltan datos.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'El email no es válido.' });
    }
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'El usuario solo puede tener minúsculas, números y guiones.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });
    }
    const planes = await db.getPlanes();
    if (!planes[planId]) {
      return res.status(400).json({ error: 'Elegí un plan válido.' });
    }

    const mongo = db.getDb();
    const existente = await mongo.collection('clientes').findOne({ slug });
    if (existente) return res.status(409).json({ error: 'Ese usuario ya está en uso, probá con otro.' });

    let descuentoPct = 0;
    let comisionPct = 0;
    let codigoGuardado = null;
    if (codigoTexto) {
      // "Consumir" el código de forma atómica (buscar + sumar el uso en un solo paso), para
      // que dos altas al mismo tiempo no puedan pasar las dos un código de un solo uso.
      const codigoDoc = await mongo.collection('codigos').findOneAndUpdate(
        {
          codigo: codigoTexto,
          activo: true,
          $or: [
            { usos_maximos: null },
            { usos_maximos: { $exists: false } },
            { $expr: { $lt: ['$usos_actuales', '$usos_maximos'] } }
          ]
        },
        { $inc: { usos_actuales: 1 } }
      );
      if (!codigoDoc) return res.status(400).json({ error: 'El código de descuento no es válido o ya se usó.' });
      descuentoPct = codigoDoc.descuento_pct;
      comisionPct = codigoDoc.comision_pct;
      codigoGuardado = codigoTexto;
    }

    const precioLista = frecuencia === 'anual' ? planes[planId].precio_ars_anual : planes[planId].precio_ars;
    const precioFinal = Math.round(precioLista * (1 - descuentoPct / 100));

    const cliente = await db.crearCliente({
      slug,
      nombre,
      email_notificacion: email,
      admin_password: password,
      plan: planId,
      precio_pactado: precioFinal,
      frecuencia_pago: frecuencia,
      origen: 'landing',
      codigo_referido: codigoGuardado,
      descuento_pct_aplicado: descuentoPct,
      comision_pct_aplicada: comisionPct
    });

    req.session.clienteId = cliente._id.toString();
    req.session.clienteSlug = cliente.slug;

    res.json({ ok: true, slug: cliente.slug });
  })
);

// ---------- Embedded Signup de WhatsApp ----------
// Probado en vivo: la página alojada por Meta (business.facebook.com/messaging/whatsapp/
// onboard) nunca redirige de vuelta a nuestro sitio, pase lo que pase - está pensada para
// que el dueño del negocio se quede siempre adentro de Meta. Por eso el cliente ahora pasa
// por /conectar-whatsapp.html (nuestra propia página, con el SDK de JavaScript de Meta
// embebido), que recibe waba_id/phone_number_id directo en el navegador vía postMessage y
// se los manda a POST /whatsapp/conectar, más abajo.
//
// El código de acá abajo (GET /whatsapp/callback, a partir del "code"/"state" de un
// redirect) se deja sin usar por ahora - lo armamos antes de probar en vivo y descubrir que
// ese flujo hosteado por Meta no redirige. Queda por si en algún momento se arma otro flujo
// (por ejemplo, un login de Facebook para empresas tradicional) que sí lo necesite.
const WHATSAPP_CALLBACK_URL = 'https://crm.frontyback.com/api/public/whatsapp/callback';

function paginaWhatsapp(mensaje, { error = false } = {}) {
  return (
    `<html><body style="font-family: sans-serif; text-align: center; padding: 60px;">` +
    `<h2>${error ? 'No se pudo completar la conexión' : '¡Listo!'}</h2><p>${mensaje}</p></body></html>`
  );
}

router.get('/whatsapp/callback', asyncHandler(async (req, res) => {
  console.log('Callback de WhatsApp Embedded Signup recibido:', JSON.stringify(req.query));
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send(paginaWhatsapp('Falta el código de autorización de Meta. Avisale a FrontyBack.', { error: true }));
  }

  const slug = String(state || '').trim();
  const cliente = slug ? await db.getDb().collection('clientes').findOne({ slug }) : null;
  if (!cliente) {
    console.warn(`Callback de WhatsApp sin cliente identificable (state="${state}").`);
    return res.status(400).send(paginaWhatsapp('No pudimos identificar a qué cuenta pertenece esta conexión. Avisale a FrontyBack.', { error: true }));
  }

  // Si algo falla de acá en adelante, Meta ya conectó el WhatsApp de su lado - no tiene
  // sentido asustar al cliente con un error, mejor le avisamos a Hugo para que lo termine
  // a mano y al cliente le mostramos el mismo mensaje de éxito.
  const avisarYMostrarExito = async (motivo) => {
    console.error(`Embedded Signup de "${slug}" quedó incompleto: ${motivo}`);
    try {
      await email.enviarAvisoConexionManual({ nombreCliente: cliente.nombre, slug, motivo });
    } catch (err) {
      console.error('No se pudo mandar el aviso de conexión manual:', err.message);
    }
    return res.send(paginaWhatsapp('Tu WhatsApp quedó conectado. Ya podés cerrar esta ventana.'));
  };

  // 1. Canjear el código por un token que representa el permiso que el cliente acaba de dar.
  const tokenParams = new URLSearchParams({
    client_id: process.env.WHATSAPP_APP_ID || '',
    client_secret: process.env.WHATSAPP_APP_SECRET || '',
    redirect_uri: WHATSAPP_CALLBACK_URL,
    code: String(code)
  });
  let accessToken;
  try {
    const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${tokenParams}`);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Error canjeando el código de WhatsApp por un token:', tokenData);
      return avisarYMostrarExito(`Meta rechazó el canje del código: ${JSON.stringify(tokenData)}`);
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    return avisarYMostrarExito(`Error de red canjeando el código: ${err.message}`);
  }

  // 2. Inspeccionar ese token para saber EXACTAMENTE qué WABA se acaba de compartir en esta
  // autorización puntual (los "granular_scopes" listan el target_id de este permiso, a
  // diferencia de listar todas las WABA que FrontyBack puede ver, que incluiría las de
  // otros clientes ya conectados).
  let wabaId;
  try {
    const debugParams = new URLSearchParams({
      input_token: accessToken,
      access_token: `${process.env.WHATSAPP_APP_ID}|${process.env.WHATSAPP_APP_SECRET}`
    });
    const debugRes = await fetch(`https://graph.facebook.com/v21.0/debug_token?${debugParams}`);
    const debugData = await debugRes.json();
    console.log(`debug_token de WhatsApp para "${slug}":`, JSON.stringify(debugData));
    const scopes = debugData?.data?.granular_scopes || [];
    const wabaScope = scopes.find((s) => s.scope === 'whatsapp_business_management') || scopes.find((s) => s.scope === 'whatsapp_business_messaging');
    wabaId = wabaScope?.target_ids?.[0];
  } catch (err) {
    return avisarYMostrarExito(`Error inspeccionando el token para encontrar la WABA: ${err.message}`);
  }
  if (!wabaId) {
    return avisarYMostrarExito('No encontramos ninguna WABA en los permisos del token (revisá el log del debug_token).');
  }

  // 3. Buscar el número de esa WABA.
  let phoneNumberId;
  let displayPhone;
  try {
    const numRes = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?access_token=${process.env.WHATSAPP_TOKEN}`
    );
    const numData = await numRes.json();
    console.log(`Números de la WABA ${wabaId} para "${slug}":`, JSON.stringify(numData));
    const numero = numData?.data?.[0];
    phoneNumberId = numero?.id;
    displayPhone = numero?.display_phone_number;
  } catch (err) {
    return avisarYMostrarExito(`Error consultando los números de la WABA ${wabaId}: ${err.message}`);
  }
  if (!phoneNumberId) {
    return avisarYMostrarExito(`Encontramos la WABA ${wabaId} pero no tiene ningún número de teléfono cargado.`);
  }

  // 4. Suscribir nuestra app a los webhooks de esa WABA - sin esto Meta no nos manda los
  // mensajes que le lleguen a ese número, aunque quede "conectado".
  try {
    await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
  } catch (err) {
    console.error(`No se pudo suscribir la WABA ${wabaId} a los webhooks (seguimos igual, se puede reintentar a mano):`, err.message);
  }

  // 5. Guardar el número en el cliente, respetando el tope de WhatsApp del plan.
  try {
    await db.agregarWhatsappNumero(cliente._id, { phone_number_id: phoneNumberId, etiqueta: '' });
  } catch (err) {
    return avisarYMostrarExito(`El número ${displayPhone || phoneNumberId} (WABA ${wabaId}) se conectó en Meta pero no se pudo guardar: ${err.message}`);
  }

  console.log(`WhatsApp conectado OK para "${slug}": WABA ${wabaId}, número ${phoneNumberId} (${displayPhone}).`);
  res.send(paginaWhatsapp('Tu WhatsApp quedó conectado. Ya podés cerrar esta ventana.'));
}));

// Flujo real en uso: lo llama public/conectar-whatsapp.html con el waba_id y phone_number_id
// que llegaron directo del SDK de JavaScript de Meta (postMessage) - no hace falta canjear
// ningún código ni inspeccionar tokens, Meta ya nos los entrega resueltos.
router.post('/whatsapp/conectar', asyncHandler(async (req, res) => {
  const slug = String(req.body?.slug || '').trim();
  const wabaId = String(req.body?.waba_id || '').trim();
  const phoneNumberId = String(req.body?.phone_number_id || '').trim();

  const cliente = slug ? await db.getDb().collection('clientes').findOne({ slug }) : null;
  if (!cliente) return res.status(404).json({ error: 'No pudimos identificar a qué cuenta pertenece esta conexión.' });
  if (!wabaId || !phoneNumberId) return res.status(400).json({ error: 'Faltan datos de la conexión (Meta no mandó la WABA o el número).' });

  try {
    await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
  } catch (err) {
    console.error(`No se pudo suscribir la WABA ${wabaId} a los webhooks (seguimos igual, se puede reintentar a mano):`, err.message);
  }

  try {
    await db.agregarWhatsappNumero(cliente._id, { phone_number_id: phoneNumberId, waba_id: wabaId, etiqueta: '' });
  } catch (err) {
    try {
      await email.enviarAvisoConexionManual({
        nombreCliente: cliente.nombre,
        slug: cliente.slug,
        motivo: `El número ${phoneNumberId} (WABA ${wabaId}) llegó del SDK pero no se pudo guardar: ${err.message}`
      });
    } catch (mailErr) {
      console.error('No se pudo mandar el aviso de conexión manual:', mailErr.message);
    }
    return res.status(400).json({ error: err.message });
  }

  // Registra el número para poder mandar mensajes (paso aparte de la verificación del
  // Embedded Signup, si se omite da error 133010 "Account not registered" recién al
  // intentar mandar algo) y da de alta las plantillas de turnos en esta WABA - todo mejor
  // esfuerzo, no bloquea la respuesta si falla.
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  whatsapp.registrarNumero({ phoneNumberId, pin }).catch((err) => console.error('Error registrando el número para mensajería:', err.message));
  turnosWhatsapp.asegurarPlantillas(wabaId).catch((err) => console.error('Error asegurando plantillas de turnos:', err.message));
  whatsapp.asegurarPlantillaSeguimiento(wabaId).catch((err) => console.error('Error asegurando plantilla de seguimiento:', err.message));

  console.log(`WhatsApp conectado OK (SDK) para "${slug}": WABA ${wabaId}, número ${phoneNumberId}.`);
  res.json({ ok: true });
}));

// ---------- Conexión de Meta Ads (leads de formularios instantáneos) ----------
// Mismo patrón que /whatsapp/conectar: lo llama public/conectar-meta-ads.html con lo que
// ya resolvió el SDK de JavaScript de Meta (login + /me/accounts), acá solo falta
// suscribir la página al webhook de leadgen y guardarla.
router.post('/meta-leads/conectar', asyncHandler(async (req, res) => {
  const slug = String(req.body?.slug || '').trim();
  const pageId = String(req.body?.page_id || '').trim();
  const pageName = String(req.body?.page_name || '').trim();
  const pageAccessToken = String(req.body?.page_access_token || '').trim();

  const cliente = slug ? await db.getDb().collection('clientes').findOne({ slug }) : null;
  if (!cliente) return res.status(404).json({ error: 'No pudimos identificar a qué cuenta pertenece esta conexión.' });
  if (!pageId || !pageAccessToken) return res.status(400).json({ error: 'Faltan datos de la página.' });

  try {
    await metaLeads.suscribirPagina({ pageId, pageAccessToken });
  } catch (err) {
    return res.status(400).json({ error: `No se pudo suscribir la página a los leads: ${err.message}` });
  }

  try {
    await db.agregarMetaPage(cliente._id, { page_id: pageId, page_name: pageName, page_access_token: pageAccessToken });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  console.log(`Meta Ads conectado OK para "${slug}": página ${pageId} (${pageName}).`);
  res.json({ ok: true });
}));

// ---------- Reserva pública de turnos (public/reservar.html) ----------
const TELEFONO_RE = /^\+?[\d\s-]{6,20}$/;

router.get('/turnos/:slug/config', asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });
  const config = await db.getTurnosConfig(cliente._id);
  res.json({
    nombre_negocio: cliente.nombre,
    servicios: config.servicios,
    // Solo id+nombre - la disponibilidad de cada uno es interna, se resuelve del lado del
    // servidor en /horarios.
    profesionales: (config.profesionales || []).map((p) => ({ id: p.id, nombre: p.nombre })),
    sena: { activa: Boolean(config.sena_activa) && config.sena_monto > 0, monto: config.sena_monto || 0 }
  });
}));

router.get('/turnos/:slug/horarios', asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });
  const servicioId = String(req.query.servicio_id || '');
  const profesionalId = String(req.query.profesional_id || '') || undefined;
  if (!servicioId) return res.status(400).json({ error: 'Falta el servicio.' });

  try {
    const dias = await db.horariosDisponibles(cliente._id, { servicioId, profesionalId });
    res.json({ dias });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

const reservaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Demasiadas reservas seguidas desde acá. Probá de nuevo más tarde.' }
});

router.post('/turnos/:slug/reservar', reservaLimiter, asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });
  if (!db.estadoPermiteCaptura(cliente.estado_pago)) {
    return res.status(400).json({ error: 'Este negocio no está aceptando reservas en este momento.' });
  }

  const body = req.body || {};
  if (String(body._hp || '').trim()) return res.json({ ok: true }); // trampa para bots

  const nombre = String(body.nombre || '').trim().slice(0, 120);
  const telefono = String(body.telefono || '').trim();
  const emailContacto = String(body.email || '').trim();
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre.' });
  if (!TELEFONO_RE.test(telefono)) return res.status(400).json({ error: 'El teléfono no es válido.' });
  if (emailContacto && !EMAIL_RE.test(emailContacto)) return res.status(400).json({ error: 'El email no es válido.' });

  let turno;
  try {
    turno = await db.crearTurno(cliente._id, {
      servicio_id: String(body.servicio_id || ''),
      profesional_id: String(body.profesional_id || ''),
      fecha: String(body.fecha || ''),
      hora_inicio: String(body.hora_inicio || ''),
      nombre_contacto: nombre,
      telefono_contacto: telefono,
      email_contacto: emailContacto
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Si el negocio pide seña, el turno queda "pendiente_pago" (ocupando el horario, ver
  // db.js filtroEstadoOcupado) y recién se avisa al negocio y al cliente cuando el webhook
  // de Mercado Pago confirme el pago (procesarNotificacionMercadoPagoTurno, abajo) - no
  // tiene sentido avisar "reservó" de algo que todavía puede no llegar a pagarse.
  if (turno.estado === 'pendiente_pago') {
    try {
      const preferencia = await mercadopagoConnect.crearPreferenciaSeña(cliente, turno, turno.sena_monto);
      await db.getDb().collection('turnos').updateOne({ _id: turno._id }, { $set: { mercadopago_preference_id: preferencia.id } });
      return res.json({ ok: true, pago_requerido: true, init_point: preferencia.init_point, monto: turno.sena_monto });
    } catch (err) {
      await db.getDb().collection('turnos').updateOne({ _id: turno._id }, { $set: { estado: 'cancelado' } });
      return res.status(400).json({ error: `No se pudo generar el cobro de la seña: ${err.message}` });
    }
  }

  await confirmarYNotificarTurno(cliente, turno);

  res.json({
    ok: true,
    turno: {
      fecha: turno.fecha,
      hora_inicio: turno.hora_inicio,
      servicio_nombre: turno.servicio_nombre,
      profesional_nombre: turno.profesional_nombre,
      token_gestion: turno.token_gestion
    }
  });
}));

// ---------- Gestión del turno por el cliente final, sin login (public/mi-turno.html) ----------
// El token (server/db.js, crearTurno) identifica el turno sin necesitar el slug del
// negocio - alcanza con tenerlo para cancelar o reprogramar, no hace falta loguearse ni
// escribirle al negocio para un cambio simple.
const gestionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Demasiados intentos seguidos desde acá. Probá de nuevo más tarde.' }
});
router.use('/turnos/gestionar', gestionLimiter);

router.get('/turnos/gestionar/:token', asyncHandler(async (req, res) => {
  const encontrado = await db.obtenerTurnoPorToken(req.params.token);
  if (!encontrado) return res.status(404).json({ error: 'No encontramos ese turno.' });
  const { turno, nombreNegocio, slugNegocio } = encontrado;
  res.json({
    nombre_negocio: nombreNegocio,
    slug_negocio: slugNegocio,
    turno: {
      servicio_id: turno.servicio_id,
      servicio_nombre: turno.servicio_nombre,
      profesional_id: turno.profesional_id,
      profesional_nombre: turno.profesional_nombre,
      fecha: turno.fecha,
      hora_inicio: turno.hora_inicio,
      nombre_contacto: turno.nombre_contacto,
      estado: turno.estado
    }
  });
}));

router.get('/turnos/gestionar/:token/horarios', asyncHandler(async (req, res) => {
  const encontrado = await db.obtenerTurnoPorToken(req.params.token);
  if (!encontrado) return res.status(404).json({ error: 'No encontramos ese turno.' });
  try {
    const dias = await db.horariosDisponibles(encontrado.turno.cliente_id, {
      servicioId: encontrado.turno.servicio_id,
      profesionalId: encontrado.turno.profesional_id || undefined
    });
    res.json({ dias });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/turnos/gestionar/:token/cancelar', asyncHandler(async (req, res) => {
  try {
    await db.cancelarTurnoPorToken(req.params.token);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/turnos/gestionar/:token/reprogramar', asyncHandler(async (req, res) => {
  const fecha = String(req.body?.fecha || '');
  const horaInicio = String(req.body?.hora_inicio || '');
  if (!fecha || !horaInicio) return res.status(400).json({ error: 'Falta la fecha o el horario.' });

  try {
    const turno = await db.reprogramarTurnoPorToken(req.params.token, { fecha, hora_inicio: horaInicio });

    // Mismo mensaje que al reservar por primera vez, ahora con la fecha/hora nueva - el
    // cliente ve el cambio confirmado en la pantalla, pero sin esto no le queda ningún
    // registro en el chat de WhatsApp (puede tener costo real si pasaron las 24hs, igual
    // que cualquier mensaje proactivo de turnos).
    const cliente = await db.getDb().collection('clientes').findOne({ _id: turno.cliente_id });
    if (cliente) {
      await turnosWhatsapp.enviarConfirmacion(cliente, turno);

      // La ficha del tablero quedaba con el mensaje de la reserva ORIGINAL para siempre -
      // esto la actualiza (y la saca de "fría" si estaba marcada así) cada vez que el
      // cliente cambia de día u horario, igual que un mensaje nuevo de WhatsApp.
      const conProfesional = turno.profesional_nombre ? `, con ${turno.profesional_nombre}` : '';
      await fichas.registrarConsulta({
        clienteId: cliente._id,
        columnaInicial: cliente.columnas[0].id,
        contacto: turno.telefono_contacto,
        nombre: turno.nombre_contacto,
        origen: 'turno',
        mensaje: `Cambió su turno a: ${turno.servicio_nombre}${conProfesional}, ${turno.fecha} a las ${turno.hora_inicio}hs.`
      });
    }

    res.json({ ok: true, turno: { fecha: turno.fecha, hora_inicio: turno.hora_inicio, servicio_nombre: turno.servicio_nombre, profesional_nombre: turno.profesional_nombre } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ---------- Catálogo público (public/pedir.html) ----------
// No usa la API de WhatsApp de Meta para nada: el pedido se arma como un link wa.me común,
// lo manda el cliente final desde su propio WhatsApp. Por eso alcanza con el estado de
// pago para decidir si se muestra el catálogo - no depende de tener un número conectado.
router.get('/catalogo/:slug', asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });
  if (!db.estadoPermiteCaptura(cliente.estado_pago)) {
    return res.status(404).json({ error: 'Este catálogo no está disponible en este momento.' });
  }

  const [config, items] = await Promise.all([
    db.getCatalogoConfig(cliente._id),
    db.listarCatalogo(cliente._id, { soloDisponibles: true })
  ]);

  res.json({
    nombre_negocio: cliente.nombre,
    telefono_pedidos: config.telefono_pedidos || '',
    items: items.map((i) => ({ nombre: i.nombre, descripcion: i.descripcion, precio: i.precio, categoria: i.categoria }))
  });
}));

// ---------- Tarjeta de fidelización pública (public/fidelizacion.html) ----------
const fidelidadRegistroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Demasiados registros seguidos desde acá. Probá de nuevo más tarde.' }
});

router.post('/fidelidad/:slug/registrar', fidelidadRegistroLimiter, asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });
  if (String(req.body?._hp || '').trim()) return res.json({ ok: true, codigo: null }); // trampa para bots

  try {
    const tarjeta = await db.registrarClienteFidelidad(cliente._id, req.body || {});
    res.json({ ok: true, codigo: tarjeta.codigo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/fidelidad/:slug/tarjeta/:codigo', asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ slug: req.params.slug });
  if (!cliente) return res.status(404).json({ error: 'No existe ese negocio.' });

  try {
    const [config, tarjeta] = await Promise.all([
      db.getFidelidadConfig(cliente._id),
      db.getTarjetaFidelidad(cliente._id, req.params.codigo)
    ]);
    res.json({
      nombre_negocio: cliente.nombre,
      nombre_cliente: tarjeta.nombre,
      puntos: tarjeta.puntos,
      premios: config.premios.map((p) => ({ ...p, disponible: tarjeta.puntos >= p.puntos_necesarios }))
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
}));

module.exports = router;
