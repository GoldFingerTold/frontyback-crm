// Turnos: incluido desde el plan Esencial (no es exclusivo de ningún plan superior, a
// diferencia de Estadísticas/Plano de salón). Cualquier usuario logueado puede ver la
// agenda; configurar servicios/disponibilidad y cancelar turnos es solo de Gerencia - es
// la configuración del negocio, no una tarea del día a día.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');

const router = express.Router();
router.use(requireAuth);

router.get('/config', asyncHandler(async (req, res) => {
  const config = await db.getTurnosConfig(req.session.clienteId);
  res.json(config);
}));

router.put('/servicios', requireGerencia, asyncHandler(async (req, res) => {
  const { servicios } = req.body || {};
  if (!Array.isArray(servicios)) return res.status(400).json({ error: 'Faltan los servicios.' });

  const limpios = servicios.map((s) => ({
    id: s.id || crypto.randomUUID(),
    nombre: String(s.nombre || '').trim().slice(0, 60) || 'Servicio',
    duracion_min: Math.min(Math.max(parseInt(s.duracion_min, 10) || 30, 10), 480)
  }));
  const config = await db.guardarServicios(req.session.clienteId, limpios);
  res.json(config);
}));

const DIA_VALIDO = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

router.put('/disponibilidad', requireGerencia, asyncHandler(async (req, res) => {
  const { disponibilidad } = req.body || {};
  if (!Array.isArray(disponibilidad) || disponibilidad.length !== 7) {
    return res.status(400).json({ error: 'La disponibilidad tiene que tener los 7 días de la semana.' });
  }
  for (const d of disponibilidad) {
    if (!DIA_VALIDO(d.dia) || !HORA_RE.test(d.desde) || !HORA_RE.test(d.hasta)) {
      return res.status(400).json({ error: 'Horario inválido.' });
    }
    if (d.desde >= d.hasta) {
      return res.status(400).json({ error: 'El horario de inicio tiene que ser antes que el de cierre.' });
    }
  }
  const limpio = disponibilidad.map((d) => ({ dia: d.dia, activo: !!d.activo, desde: d.desde, hasta: d.hasta }));
  const config = await db.guardarDisponibilidad(req.session.clienteId, limpio);
  res.json(config);
}));

// Switches de por qué canal mandar la confirmación/recordatorio de turno. El email no
// tiene costo; el WhatsApp sí, fuera de la ventana de 24hs - por eso arranca apagado para
// cuentas nuevas (server/db.js, getTurnosConfig) y el que lo prende lo hace sabiendo eso.
router.put('/recordatorios', requireGerencia, asyncHandler(async (req, res) => {
  const { whatsapp, email } = req.body || {};
  const config = await db.guardarRecordatorios(req.session.clienteId, { whatsapp, email });
  res.json(config);
}));

router.get('/', asyncHandler(async (req, res) => {
  const hoy = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // hoy en hora de Argentina
  const turnos = await db.listarTurnos(req.session.clienteId, { desde: hoy });
  res.json({ turnos });
}));

router.delete('/:id', requireGerencia, asyncHandler(async (req, res) => {
  await db.cancelarTurno(req.session.clienteId, req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
