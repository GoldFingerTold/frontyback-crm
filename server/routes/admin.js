// API del tablero: listar las fichas del cliente logueado, agrupadas por columna, y
// mover una ficha de lugar (cambiar de columna y/o de posición) cuando alguien la
// arrastra en el panel.

const express = require('express');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/tablero', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);

  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  const fichas = await mongo.collection('fichas')
    .find({ cliente_id: clienteId })
    .sort({ posicion: 1 })
    .toArray();

  res.json({ columnas: cliente.columnas, fichas });
}));

router.put('/fichas/:id/mover', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const fichaId = new db.ObjectId(req.params.id);
  const { columna_id, posicion } = req.body || {};

  if (!columna_id || typeof posicion !== 'number') {
    return res.status(400).json({ error: 'Faltan columna_id o posicion.' });
  }

  const result = await mongo.collection('fichas').updateOne(
    { _id: fichaId, cliente_id: clienteId },
    { $set: { columna_id, posicion } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe esa ficha.' });

  res.json({ ok: true });
}));

module.exports = router;
