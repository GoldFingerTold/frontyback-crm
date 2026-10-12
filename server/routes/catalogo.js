// Catálogo + pedidos por WhatsApp: incluido desde el plan Esencial, igual que Turnos.
// Cualquier usuario logueado puede ver el catálogo; agregar/editar/borrar productos y
// configurar el teléfono de pedidos es solo de Gerencia.

const express = require('express');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/config', asyncHandler(async (req, res) => {
  const config = await db.getCatalogoConfig(req.session.clienteId);
  res.json(config);
}));

router.put('/config', requireGerencia, asyncHandler(async (req, res) => {
  const telefono = String(req.body?.telefono_pedidos || '').trim().slice(0, 30);
  const config = await db.guardarTelefonoPedidos(req.session.clienteId, telefono);
  res.json(config);
}));

router.get('/', asyncHandler(async (req, res) => {
  const items = await db.listarCatalogo(req.session.clienteId);
  res.json({ items });
}));

router.post('/', requireGerencia, asyncHandler(async (req, res) => {
  try {
    const item = await db.agregarItemCatalogo(req.session.clienteId, req.body || {});
    res.json(item);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/:id', requireGerencia, asyncHandler(async (req, res) => {
  await db.actualizarItemCatalogo(req.session.clienteId, req.params.id, req.body || {});
  res.json({ ok: true });
}));

router.delete('/:id', requireGerencia, asyncHandler(async (req, res) => {
  await db.eliminarItemCatalogo(req.session.clienteId, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
