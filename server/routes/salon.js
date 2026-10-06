// Plano de salón: exclusivo del plan Elite. Arma, edita y muestra el estado en vivo del
// salón de un cliente (mesas + forma del local). Vive en su propio router, separado de
// admin.js a propósito - es la parte del CRM más fácil de llevarse entera a un subdominio
// propio el día que Hugo quiera venderlo por separado, sin tocar el resto.
//
// Permisos: cualquier usuario logueado puede ver el plano y cambiar el ESTADO de una mesa
// (libre/ocupada/reservada) - es la tarea del día a día, la puede hacer cualquier empleado.
// Editar la forma del salón, y agregar/mover/borrar mesas, es solo de Gerencia - es la
// configuración del local, no cambia todos los días.

const express = require('express');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');

const router = express.Router();
router.use(requireAuth);

async function requireElite(req, res, next) {
  const mongo = db.getDb();
  const cliente = await mongo.collection('clientes').findOne({ _id: new db.ObjectId(req.session.clienteId) });
  if (!cliente || cliente.plan !== 'elite') {
    return res.status(403).json({ error: 'El Plano de salón es exclusivo del plan Elite.' });
  }
  next();
}
router.use(asyncHandler(requireElite));

function formaValida(forma) {
  if (!Array.isArray(forma) || forma.length < 3 || forma.length > 40) return false;
  return forma.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 2000 && p.y >= 0 && p.y <= 2000);
}

router.get('/', asyncHandler(async (req, res) => {
  const salon = await db.getSalon(req.session.clienteId);
  res.json(salon);
}));

router.put('/forma', requireGerencia, asyncHandler(async (req, res) => {
  const { forma } = req.body || {};
  if (!formaValida(forma)) {
    return res.status(400).json({ error: 'La forma del salón necesita entre 3 y 40 puntos válidos.' });
  }
  const salon = await db.guardarFormaSalon(req.session.clienteId, forma);
  res.json(salon);
}));

router.post('/mesas', requireGerencia, asyncHandler(async (req, res) => {
  const { nombre, x, y, ancho, alto, tipo, capacidad } = req.body || {};
  const nombreLimpio = String(nombre || '').trim().slice(0, 40) || 'Mesa';
  const salon = await db.agregarMesa(req.session.clienteId, {
    nombre: nombreLimpio,
    x: Math.min(Math.max(Number(x) || 100, 0), 2000),
    y: Math.min(Math.max(Number(y) || 100, 0), 2000),
    ancho: Math.min(Math.max(Number(ancho) || 80, 20), 400),
    alto: Math.min(Math.max(Number(alto) || 80, 20), 400),
    tipo: tipo === 'circulo' ? 'circulo' : 'rect',
    capacidad: Math.min(Math.max(parseInt(capacidad, 10) || 4, 1), 50)
  });
  res.json(salon);
}));

const ESTADOS_VALIDOS = ['libre', 'ocupada', 'reservada'];

router.put('/mesas/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const claves = Object.keys(body);
  const soloEstadoONota = claves.every((k) => k === 'estado' || k === 'nota');

  if (!soloEstadoONota && req.session.rol === 'departamento') {
    return res.status(403).json({ error: 'Solo Gerencia puede mover o redimensionar mesas.' });
  }

  const cambios = {};
  if (body.estado !== undefined) {
    if (!ESTADOS_VALIDOS.includes(body.estado)) return res.status(400).json({ error: 'Estado inválido.' });
    cambios.estado = body.estado;
  }
  if (body.nota !== undefined) cambios.nota = String(body.nota).slice(0, 200);
  if (body.nombre !== undefined) cambios.nombre = String(body.nombre).trim().slice(0, 40) || 'Mesa';
  if (body.x !== undefined) cambios.x = Math.min(Math.max(Number(body.x) || 0, 0), 2000);
  if (body.y !== undefined) cambios.y = Math.min(Math.max(Number(body.y) || 0, 0), 2000);
  if (body.ancho !== undefined) cambios.ancho = Math.min(Math.max(Number(body.ancho) || 80, 20), 400);
  if (body.alto !== undefined) cambios.alto = Math.min(Math.max(Number(body.alto) || 80, 20), 400);
  if (body.tipo !== undefined) cambios.tipo = body.tipo === 'circulo' ? 'circulo' : 'rect';
  if (body.capacidad !== undefined) cambios.capacidad = Math.min(Math.max(parseInt(body.capacidad, 10) || 1, 1), 50);

  if (Object.keys(cambios).length === 0) return res.status(400).json({ error: 'Nada para actualizar.' });

  const salon = await db.actualizarMesa(req.session.clienteId, req.params.id, cambios);
  res.json(salon);
}));

router.delete('/mesas/:id', requireGerencia, asyncHandler(async (req, res) => {
  const salon = await db.eliminarMesa(req.session.clienteId, req.params.id);
  res.json(salon);
}));

// Reiniciar: vuelve el salón al rectángulo en blanco, sin mesas. Gerencia lo puede hacer
// solo/a, sin pedirlo - pensado para cuando se quiere empezar el diseño de cero.
router.delete('/', requireGerencia, asyncHandler(async (req, res) => {
  const salon = await db.reiniciarSalon(req.session.clienteId);
  res.json(salon);
}));

module.exports = router;
