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

// El idioma del panel lo define el negocio (clientes.idioma) y viaja en la misma cookie que
// ya usa la landing (public/js/panel-i18n.js la lee) - sin httpOnly a propósito, la tiene
// que poder leer el JavaScript del navegador.
function ponerCookieIdioma(res, idioma) {
  const valor = ['es', 'en', 'pt'].includes(idioma) ? idioma : 'es';
  res.cookie('frontyback_idioma', valor, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
}

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
  // Solo Gerencia del negocio principal puede pasar de un negocio a otro de su cuenta (plan
  // Elite); un empleado, o Gerencia de un negocio agregado, se queda en el suyo.
  req.session.principalId = (usuario.rol !== 'departamento' && !cliente.grupo_id) ? cliente._id.toString() : null;
  ponerCookieIdioma(res, cliente.idioma);
  res.json({ ok: true, nombre: cliente.nombre });
}));

// --- Varios negocios en una misma cuenta (plan Elite)
async function principalDeLaSesion(req) {
  if (!req.session?.principalId) return null;
  return db.getDb().collection('clientes').findOne({ _id: new db.ObjectId(req.session.principalId) });
}

// Qué negocios tiene la cuenta, cuál está activo y si se pueden agregar más. Si el plan no
// permite varios negocios (y no hay ninguno agregado), devuelve habilitado:false y el panel no
// muestra el selector.
router.get('/negocios', requireAuth, asyncHandler(async (req, res) => {
  const principal = await principalDeLaSesion(req);
  if (!principal) return res.json({ habilitado: false });
  const max = await db.maxNegociosDeCliente(principal);
  const lista = await db.listarNegociosDelGrupo(principal._id);
  if (max <= 1 && lista.length <= 1) return res.json({ habilitado: false });
  res.json({
    habilitado: true,
    activoId: req.session.clienteId,
    max,
    puedeCrear: lista.length < max,
    negocios: lista.map((n) => ({ id: n._id.toString(), nombre: n.nombre, slug: n.slug, principal: n._id.equals(principal._id) }))
  });
}));

async function entrarAlNegocio(req, res, negocio) {
  req.session.clienteId = negocio._id.toString();
  req.session.clienteSlug = negocio.slug;
  req.session.rol = 'gerencia';
  req.session.departamento = null;
  ponerCookieIdioma(res, negocio.idioma);
}

router.post('/negocios/cambiar', requireAuth, asyncHandler(async (req, res) => {
  const principal = await principalDeLaSesion(req);
  if (!principal) return res.status(403).json({ error: 'Tu cuenta no puede cambiar de negocio.' });
  const id = String(req.body?.id || '');
  if (!/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ error: 'Negocio inválido.' });
  const lista = await db.listarNegociosDelGrupo(principal._id);
  if (!lista.some((n) => n._id.toString() === id)) return res.status(403).json({ error: 'Ese negocio no es de tu cuenta.' });
  await db.sincronizarNegociosDelGrupo(principal._id);
  const negocio = await db.getDb().collection('clientes').findOne({ _id: new db.ObjectId(id) });
  await entrarAlNegocio(req, res, negocio);
  res.json({ ok: true });
}));

router.post('/negocios', requireAuth, asyncHandler(async (req, res) => {
  const principal = await principalDeLaSesion(req);
  if (!principal) return res.status(403).json({ error: 'Tu cuenta no puede agregar negocios.' });
  if (!db.estadoPermiteRespuesta(principal.estado_pago)) {
    return res.status(403).json({ error: 'Tu suscripción no está activa.' });
  }
  const max = await db.maxNegociosDeCliente(principal);
  const lista = await db.listarNegociosDelGrupo(principal._id);
  if (lista.length >= max) {
    return res.status(403).json({ error: `Tu plan incluye hasta ${max} negocio${max === 1 ? '' : 's'}.` });
  }
  let negocio;
  try {
    negocio = await db.crearNegocioDelGrupo(principal, { nombre: req.body?.nombre, slug: req.body?.slug });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  await entrarAlNegocio(req, res, negocio);
  res.json({ ok: true, id: negocio._id.toString() });
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
module.exports.ponerCookieIdioma = ponerCookieIdioma;
module.exports.requireGerencia = requireGerencia;
