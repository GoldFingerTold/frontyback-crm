// Alta por autoservicio desde la landing de ventas (index.html): cualquiera puede
// anotarse eligiendo un plan, con 7 días de prueba gratis. Es la única ruta pública que
// crea cuentas, así que lleva el mismo blindaje que el formulario de contacto del
// webhook (límite de envíos, honeypot, validación real) - ver server/routes/webhooks.js.

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const email = require('../services/email');

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

router.get('/planes', asyncHandler(async (req, res) => {
  const planes = await db.getPlanes();
  res.json({ planes, dias_prueba: db.DIAS_PRUEBA_GRATIS });
}));

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

// ---------- Embedded Signup de WhatsApp (alojado por Meta) ----------
// El super-admin genera un link personalizado por cliente (ver server/routes/superadmin.js,
// GET /clientes/:id/whatsapp-link) con el slug del cliente en "state". Cuando esa persona
// termina de conectar su WhatsApp en la página alojada por Meta, el navegador vuelve acá con
// un "code" (para canjear por un token) y el mismo "state", así sabemos a qué cliente
// corresponde.
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

module.exports = router;
