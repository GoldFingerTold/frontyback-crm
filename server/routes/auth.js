// Login del panel - cada persona entra con su propio usuario y contraseña (no el negocio
// entero compartiendo un solo login). El primer usuario de cada cliente es "Gerencia" y ve
// todas las fichas; el resto de los empleados (los crea Gerencia desde el tablero) solo ve
// las de su departamento. El campo del body sigue llamándose "slug" por compatibilidad con
// el formulario de login que ya existe, pero ahora identifica a la persona, no al negocio.

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
  const { slug: usuarioLogin, password } = req.body || {};
  if (!usuarioLogin || !password) return res.status(400).json({ error: 'Faltan datos.' });

  const usuario = await db.getDb().collection('usuarios').findOne({ usuario: usuarioLogin });
  if (!usuario) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  const ok = bcrypt.compareSync(password, usuario.password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  const cliente = await db.getDb().collection('clientes').findOne({ _id: usuario.cliente_id });
  if (!cliente) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });

  req.session.clienteId = cliente._id.toString();
  req.session.clienteSlug = cliente.slug;
  req.session.usuarioId = usuario._id.toString();
  req.session.usuarioNombre = usuario.nombre;
  req.session.rol = usuario.rol;
  req.session.departamento = usuario.departamento || null;
  res.json({ ok: true, nombre: cliente.nombre });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', (req, res) => {
  res.json({
    autenticado: Boolean(req.session && req.session.clienteId),
    clienteSlug: req.session?.clienteSlug || null,
    rol: req.session?.rol || null,
    departamento: req.session?.departamento || null
  });
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.clienteId) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  next();
}

// Solo Gerencia puede gestionar empleados. Una sesión vieja (de antes de que existiera este
// sistema de usuarios) no tiene "rol" guardado - se la trata como Gerencia, porque esa
// cuenta era la única que existía y veía todo.
function requireGerencia(req, res, next) {
  if (req.session?.rol === 'departamento') {
    return res.status(403).json({ error: 'Solo Gerencia puede hacer esto.' });
  }
  next();
}

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.requireGerencia = requireGerencia;
