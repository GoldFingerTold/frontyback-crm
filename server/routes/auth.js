// Login del panel - multi-cliente: cada negocio entra con el "slug" de su cuenta (se lo
// pasamos nosotros al darlo de alta) más su contraseña, igual que el resto de los sitios
// de FrontyBack.

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Como mucho 10 intentos cada 15 min por IP - deja de sobra para que alguien se equivoque
// de contraseña un par de veces, pero corta un ataque de fuerza bruta contra el login.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en un rato.' }
});

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { slug, password } = req.body || {};
  if (!slug || !password) return res.status(400).json({ error: 'Faltan datos.' });

  const cliente = await db.getDb().collection('clientes').findOne({ slug });
  if (!cliente) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  const ok = bcrypt.compareSync(password, cliente.admin_password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  req.session.clienteId = cliente._id.toString();
  req.session.clienteSlug = cliente.slug;
  res.json({ ok: true, nombre: cliente.nombre });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', (req, res) => {
  res.json({
    autenticado: Boolean(req.session && req.session.clienteId),
    clienteSlug: req.session?.clienteSlug || null
  });
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.clienteId) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  next();
}

module.exports = router;
module.exports.requireAuth = requireAuth;
