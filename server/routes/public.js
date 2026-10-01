// Alta por autoservicio desde la landing de ventas (planes.html): cualquiera puede
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
      const codigoDoc = await mongo.collection('codigos').findOne({ codigo: codigoTexto, activo: true });
      if (!codigoDoc) return res.status(400).json({ error: 'El código de descuento no es válido.' });
      descuentoPct = codigoDoc.descuento_pct;
      comisionPct = codigoDoc.comision_pct;
      codigoGuardado = codigoTexto;
    }

    const precioLista = planes[planId].precio_ars;
    const precioFinal = Math.round(precioLista * (1 - descuentoPct / 100));

    const cliente = await db.crearCliente({
      slug,
      nombre,
      email_notificacion: email,
      admin_password: password,
      plan: planId,
      precio_mensual: precioFinal,
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

module.exports = router;
