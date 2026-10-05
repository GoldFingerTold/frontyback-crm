// Alta por autoservicio desde la landing de ventas (index.html): cualquiera puede
// anotarse eligiendo un plan, con 7 días de prueba gratis. Es la única ruta pública que
// crea cuentas, así que lleva el mismo blindaje que el formulario de contacto del
// webhook (límite de envíos, honeypot, validación real) - ver server/routes/webhooks.js.

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../asyncHandler');

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
// corresponde. Primera vez que probamos este flujo en producción, así que de movida queda
// todo bien logueado - en cuanto Hugo haga la primera conexión real vamos a ver exactamente
// qué datos manda Meta y terminar de ajustar el descubrimiento del WABA si hace falta.
const WHATSAPP_CALLBACK_URL = 'https://crm.frontyback.com/api/public/whatsapp/callback';

router.get('/whatsapp/callback', asyncHandler(async (req, res) => {
  console.log('Callback de WhatsApp Embedded Signup recibido:', JSON.stringify(req.query));
  const { code, state } = req.query;

  const paginaError = (mensaje) =>
    res.status(400).send(
      `<html><body style="font-family: sans-serif; text-align: center; padding: 60px;">` +
      `<h2>No se pudo completar la conexión</h2><p>${mensaje} Avisale a FrontyBack.</p></body></html>`
    );

  if (!code) return paginaError('Falta el código de autorización de Meta.');

  const slug = String(state || '').trim();
  const cliente = slug ? await db.getDb().collection('clientes').findOne({ slug }) : null;
  if (!cliente) {
    console.warn(`Callback de WhatsApp sin cliente identificable (state="${state}").`);
    return paginaError('No pudimos identificar a qué cuenta pertenece esta conexión.');
  }

  const params = new URLSearchParams({
    client_id: process.env.WHATSAPP_APP_ID || '',
    client_secret: process.env.WHATSAPP_APP_SECRET || '',
    redirect_uri: WHATSAPP_CALLBACK_URL,
    code: String(code)
  });

  let tokenData;
  try {
    const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?${params}`);
    tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Error canjeando el código de WhatsApp por un token:', tokenData);
      return paginaError('Meta rechazó la conexión.');
    }
  } catch (err) {
    console.error('Error de red canjeando el código de WhatsApp:', err.message);
    return paginaError('Hubo un error de red hablando con Meta.');
  }

  console.log(`Token de WhatsApp obtenido para cliente "${slug}":`, JSON.stringify(tokenData));

  // Con nuestro propio token (el system user de FrontyBack) buscamos qué WABA nos acaba de
  // compartir este cliente - se loguea completo porque es la primera vez que vemos la forma
  // real de esta respuesta en producción.
  try {
    const businessId = process.env.WHATSAPP_BUSINESS_ID;
    const wabasRes = await fetch(
      `https://graph.facebook.com/v21.0/${businessId}/client_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name}&access_token=${process.env.WHATSAPP_TOKEN}`
    );
    const wabasData = await wabasRes.json();
    console.log(`WABAs visibles para FrontyBack tras conectar "${slug}":`, JSON.stringify(wabasData));
  } catch (err) {
    console.error('Error consultando las WABA del cliente tras el Embedded Signup:', err.message);
  }

  res.send(
    '<html><body style="font-family: sans-serif; text-align: center; padding: 60px;">' +
    '<h2>¡Listo! Tu WhatsApp quedó conectado.</h2><p>Ya podés cerrar esta ventana.</p>' +
    '</body></html>'
  );
}));

module.exports = router;
