// Tarjeta de fidelización digital con QR: incluido desde el plan Esencial. Sellar una
// tarjeta y canjear un premio son tareas del día a día (cualquier empleado las hace al
// cobrar) - configurar la meta de sellos y el premio es solo de Gerencia.

const express = require('express');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/config', asyncHandler(async (req, res) => {
  const config = await db.getFidelidadConfig(req.session.clienteId);
  res.json(config);
}));

router.put('/config', requireGerencia, asyncHandler(async (req, res) => {
  const config = await db.guardarFidelidadConfig(req.session.clienteId, req.body || {});
  res.json(config);
}));

router.get('/clientes', asyncHandler(async (req, res) => {
  const clientes = await db.listarClientesFidelidad(req.session.clienteId);
  res.json({ clientes });
}));

router.post('/sellar', asyncHandler(async (req, res) => {
  const codigo = String(req.body?.codigo || '').trim();
  if (!codigo) return res.status(400).json({ error: 'Falta el código.' });
  try {
    const tarjeta = await db.sellarTarjeta(req.session.clienteId, codigo, { monto: req.body?.monto });
    const config = await db.getFidelidadConfig(req.session.clienteId);
    res.json({ tarjeta, premios: config.premios });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.post('/canjear', asyncHandler(async (req, res) => {
  const codigo = String(req.body?.codigo || '').trim();
  const premioId = String(req.body?.premio_id || '').trim();
  if (!codigo || !premioId) return res.status(400).json({ error: 'Falta el código o el premio.' });
  try {
    const tarjeta = await db.canjearPremioFidelidad(req.session.clienteId, codigo, premioId);
    res.json({ tarjeta });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

module.exports = router;
