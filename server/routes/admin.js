// API del tablero: listar las fichas del cliente logueado, agrupadas por columna, y
// mover una ficha de lugar (cambiar de columna y/o de posición) cuando alguien la
// arrastra en el panel.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');
const pagos = require('../services/pagos');

const router = express.Router();
router.use(requireAuth);

// Una sesión sin "rol" guardado es de antes de que existiera este sistema de usuarios - se
// trata como Gerencia (ve todo), igual que requireGerencia en auth.js.
function esGerencia(req) {
  return req.session.rol !== 'departamento';
}

router.get('/tablero', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);

  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  const filtroFichas = { cliente_id: clienteId };
  if (!esGerencia(req)) filtroFichas.departamento = req.session.departamento;

  const fichas = await mongo.collection('fichas')
    .find(filtroFichas)
    .sort({ posicion: 1 })
    .toArray();

  res.json({
    columnas: cliente.columnas,
    fichas,
    cliente: {
      nombre: cliente.nombre,
      slug: cliente.slug,
      estado_pago: cliente.estado_pago,
      prueba_termina: cliente.prueba_termina,
      gracia_termina: cliente.gracia_termina
    },
    usuario: {
      nombre: req.session.usuarioNombre || 'Gerencia',
      rol: esGerencia(req) ? 'gerencia' : 'departamento',
      departamento: req.session.departamento || null
    }
  });
}));

// Link de pago para reactivar el plan: lo pide el botón "Reactivar ahora" del cartel de
// aviso del tablero. Si ya había un link pendiente (el cliente lo abrió pero no llegó a
// autorizar la tarjeta), se reusa ese en vez de crear una suscripción nueva cada vez.
router.get('/pago/link', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });

  const link = await pagos.obtenerOCrearLinkDePago(cliente);
  if (!link) return res.status(400).json({ error: 'Esta cuenta no tiene un plan asignado.' });

  res.json({ link });
}));

// El monto es el único dato de la ficha que no llega solo por WhatsApp/formulario - se
// carga a mano desde el panel para poder ver cuánto vale el embudo de ventas.
router.put('/fichas/:id/monto', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const fichaId = new db.ObjectId(req.params.id);
  const { monto } = req.body || {};

  let valor = null;
  if (monto !== null && monto !== '' && monto !== undefined) {
    valor = Number(monto);
    if (!Number.isFinite(valor) || valor < 0) {
      return res.status(400).json({ error: 'Monto inválido.' });
    }
  }

  // Un empleado de departamento solo puede tocar fichas de su propio departamento - aunque
  // adivine el id de una ficha ajena, este filtro hace que no la encuentre.
  const filtro = { _id: fichaId, cliente_id: clienteId };
  if (!esGerencia(req)) filtro.departamento = req.session.departamento;

  const result = await mongo.collection('fichas').updateOne(filtro, { $set: { monto: valor } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe esa ficha.' });

  res.json({ ok: true, monto: valor });
}));

router.put('/fichas/:id/mover', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const fichaId = new db.ObjectId(req.params.id);
  const { columna_id, posicion } = req.body || {};

  if (!columna_id || typeof posicion !== 'number') {
    return res.status(400).json({ error: 'Faltan columna_id o posicion.' });
  }

  const filtro = { _id: fichaId, cliente_id: clienteId };
  if (!esGerencia(req)) filtro.departamento = req.session.departamento;

  const result = await mongo.collection('fichas').updateOne(filtro, { $set: { columna_id, posicion } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe esa ficha.' });

  res.json({ ok: true });
}));

// ---------- Empleados (solo Gerencia) ----------
// Cada empleado ve solo las fichas del departamento que se le asigna acá - los
// departamentos disponibles son las etiquetas que Hugo ya les puso a las cuentas de
// WhatsApp conectadas (server/routes/superadmin.js), para no poder escribir uno con un
// error de tipeo que no coincida con ninguna línea real.
router.get('/departamentos', requireGerencia, asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ _id: new db.ObjectId(req.session.clienteId) });
  res.json({ departamentos: db.departamentosDeCliente(cliente) });
}));

router.get('/usuarios', requireGerencia, asyncHandler(async (req, res) => {
  const usuarios = await db.getDb().collection('usuarios')
    .find({ cliente_id: new db.ObjectId(req.session.clienteId) }, { projection: { password_hash: 0 } })
    .sort({ created_at: 1 })
    .toArray();
  res.json({ usuarios });
}));

router.post('/usuarios', requireGerencia, asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const nombre = String(req.body?.nombre || '').trim();
  const usuarioLogin = String(req.body?.usuario || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const departamento = String(req.body?.departamento || '').trim();

  if (!nombre || !usuarioLogin || !password || !departamento) {
    return res.status(400).json({ error: 'Faltan datos (nombre, usuario, contraseña y departamento son obligatorios).' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });

  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  if (!db.departamentosDeCliente(cliente).includes(departamento)) {
    return res.status(400).json({ error: 'Ese departamento no existe - tiene que ser una de las etiquetas de las cuentas de WhatsApp conectadas.' });
  }

  try {
    const { insertedId } = await mongo.collection('usuarios').insertOne({
      cliente_id: clienteId,
      usuario: usuarioLogin,
      password_hash: bcrypt.hashSync(password, 10),
      nombre,
      rol: 'departamento',
      departamento,
      created_at: new Date()
    });
    res.json({ ok: true, usuario: { _id: insertedId, usuario: usuarioLogin, nombre, departamento } });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso.' });
    throw err;
  }
}));

router.delete('/usuarios/:id', requireGerencia, asyncHandler(async (req, res) => {
  const result = await db.getDb().collection('usuarios').deleteOne({
    _id: new db.ObjectId(req.params.id),
    cliente_id: new db.ObjectId(req.session.clienteId),
    rol: 'departamento' // Gerencia no se puede borrar a sí misma por acá, para no quedar afuera
  });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'No existe ese empleado.' });
  res.json({ ok: true });
}));

module.exports = router;
