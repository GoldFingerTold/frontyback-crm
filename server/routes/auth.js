// Login del panel - multi-cliente: cada negocio entra con el "slug" de su cuenta (se lo
// pasamos nosotros al darlo de alta) más su contraseña, igual que el resto de los sitios
// de FrontyBack.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
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
