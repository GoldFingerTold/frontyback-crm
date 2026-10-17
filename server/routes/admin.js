// API del tablero: listar las fichas del cliente logueado, agrupadas por columna, y
// mover una ficha de lugar (cambiar de columna y/o de posición) cuando alguien la
// arrastra en el panel.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const { requireAuth, requireGerencia } = require('./auth');
const pagos = require('../services/pagos');
const push = require('../services/push');

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

  const turnosMensajesLimiteMes = await db.maxTurnosMensajesDeCliente(cliente);
  const turnosMensajesUsadosMes = turnosMensajesLimiteMes > 0 ? await db.contarUsoTurnosEsteMes(cliente._id) : 0;
  const audiosLimiteMes = await db.maxAudiosMesDeCliente(cliente);
  const audiosUsadosMes = audiosLimiteMes != null ? await db.contarUsoAudioEsteMes(cliente._id) : 0;

  res.json({
    columnas: cliente.columnas,
    fichas,
    cliente: {
      nombre: cliente.nombre,
      slug: cliente.slug,
      plan: cliente.plan,
      estado_pago: cliente.estado_pago,
      prueba_termina: cliente.prueba_termina,
      gracia_termina: cliente.gracia_termina,
      avisos_lead_email: cliente.avisos_lead_email !== false,
      resumen_semanal_email: cliente.resumen_semanal_email !== false,
      google_review_link: cliente.google_review_link || '',
      whatsapp_pago_pendiente: cliente.whatsapp_pago_pendiente === true,
      turnos_mensajes_limite_mes: turnosMensajesLimiteMes,
      turnos_mensajes_usados_mes: turnosMensajesUsadosMes,
      audios_limite_mes: audiosLimiteMes,
      audios_usados_mes: audiosUsadosMes
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

// Prender/apagar el aviso por email de "lead nuevo" (server/routes/webhooks.js) - útil
// para cuentas con pocas consultas, un estorbo para las que tienen mucho volumen.
router.put('/preferencias', requireGerencia, asyncHandler(async (req, res) => {
  const set = {};
  if (req.body?.avisos_lead_email !== undefined) set.avisos_lead_email = Boolean(req.body.avisos_lead_email);
  if (req.body?.resumen_semanal_email !== undefined) set.resumen_semanal_email = Boolean(req.body.resumen_semanal_email);
  if (req.body?.google_review_link !== undefined) set.google_review_link = String(req.body.google_review_link).trim().slice(0, 300);
  await db.getDb().collection('clientes').updateOne(
    { _id: new db.ObjectId(req.session.clienteId) },
    { $set: set }
  );
  res.json({ ok: true });
}));

// ---------- Notificaciones push (PWA) ----------
// Cualquier usuario logueado puede suscribirse (no solo Gerencia) - un empleado de
// departamento también puede querer el aviso al instante de los leads de su propio
// departamento, igual que recibe el resto del tablero filtrado.
router.get('/push/public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

router.post('/push/suscribir', asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Suscripción inválida.' });
  }
  await db.getDb().collection('push_subscriptions').updateOne(
    { endpoint },
    {
      $set: {
        endpoint,
        keys,
        cliente_id: new db.ObjectId(req.session.clienteId),
        usuario_id: new db.ObjectId(req.session.usuarioId),
        created_at: new Date()
      }
    },
    { upsert: true }
  );
  res.json({ ok: true });
}));

router.delete('/push/suscribir', asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await db.getDb().collection('push_subscriptions').deleteOne({ endpoint });
  res.json({ ok: true });
}));

// Exportar todos los contactos a CSV, para que el dueño del negocio tenga la tranquilidad
// de que sus datos no quedan encerrados en el CRM - solo Gerencia, es información de todos
// los departamentos junta.
function csvCelda(valor) {
  const texto = String(valor ?? '');
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

router.get('/fichas/exportar', requireGerencia, asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  const columnasPorId = Object.fromEntries((cliente.columnas || []).map((c) => [c.id, c.nombre]));

  const fichas = await mongo.collection('fichas').find({ cliente_id: clienteId }).sort({ fecha_hora_recibido: -1 }).toArray();

  const encabezado = ['Nombre', 'Contacto', 'Origen', 'Departamento', 'Etapa', 'Monto', 'Etiquetas', 'Recibido', 'Último mensaje'];
  const filas = fichas.map((f) => [
    f.nombre || '',
    f.contacto || '',
    f.origen || '',
    f.departamento || '',
    columnasPorId[f.columna_id] || '',
    f.monto ?? '',
    (f.etiquetas || []).join(' | '),
    f.fecha_hora_recibido ? new Date(f.fecha_hora_recibido).toISOString() : '',
    f.ultimo_mensaje || ''
  ]);

  const csv = '﻿' + [encabezado, ...filas].map((fila) => fila.map(csvCelda).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contactos-${cliente.slug}.csv"`);
  res.send(csv);
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

// Notas internas: comentarios del equipo sobre una ficha, separados del historial de
// WhatsApp con el cliente - el cliente nunca las ve, son solo para coordinarse entre
// compañeros ("ya la llamé, pidió presupuesto para 50 personas").
router.post('/fichas/:id/notas', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const fichaId = new db.ObjectId(req.params.id);
  const texto = String(req.body?.texto || '').trim().slice(0, 500);
  if (!texto) return res.status(400).json({ error: 'La nota no puede estar vacía.' });

  const filtro = { _id: fichaId, cliente_id: clienteId };
  if (!esGerencia(req)) filtro.departamento = req.session.departamento;

  const nota = { texto, autor: req.session.usuarioNombre || 'Gerencia', fecha_hora: new Date() };
  const result = await mongo.collection('fichas').updateOne(filtro, { $push: { notas_internas: nota } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe esa ficha.' });

  res.json({ ok: true, nota });
}));

// Etiquetas libres para segmentar contactos más allá de la columna del Kanban (ej. "VIP",
// "solo consultó precio") - se reemplaza la lista entera cada vez, más simple que agregar/
// quitar una por una y el panel igual manda siempre el array completo actualizado.
router.put('/fichas/:id/etiquetas', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const fichaId = new db.ObjectId(req.params.id);
  const crudo = Array.isArray(req.body?.etiquetas) ? req.body.etiquetas : [];

  const etiquetas = [...new Set(
    crudo.map((e) => String(e || '').trim().slice(0, 30)).filter(Boolean)
  )].slice(0, 10);

  const filtro = { _id: fichaId, cliente_id: clienteId };
  if (!esGerencia(req)) filtro.departamento = req.session.departamento;

  const result = await mongo.collection('fichas').updateOne(filtro, { $set: { etiquetas } });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe esa ficha.' });

  res.json({ ok: true, etiquetas });
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

// ---------- Estadísticas (exclusivo del plan Premium, solo Gerencia) ----------
// Todo sale de datos que ya se guardan solos (columna_id, monto, origen, departamento,
// fecha) - no hace falta que el cliente cargue nada aparte para tener estos gráficos.
router.get('/estadisticas', requireGerencia, asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.session.clienteId);
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });

  if (cliente.plan !== 'premium' && cliente.plan !== 'elite') {
    return res.status(403).json({ error: 'Las estadísticas son exclusivas de los planes Premium y Elite.' });
  }

  const fichasCol = mongo.collection('fichas');

  const [porColumna, porOrigen, porDepartamento] = await Promise.all([
    fichasCol.aggregate([
      { $match: { cliente_id: clienteId } },
      { $group: { _id: '$columna_id', cantidad: { $sum: 1 }, monto_total: { $sum: { $ifNull: ['$monto', 0] } } } }
    ]).toArray(),
    fichasCol.aggregate([
      { $match: { cliente_id: clienteId } },
      { $group: { _id: '$origen', cantidad: { $sum: 1 } } }
    ]).toArray(),
    fichasCol.aggregate([
      { $match: { cliente_id: clienteId } },
      { $group: { _id: '$departamento', cantidad: { $sum: 1 } } }
    ]).toArray()
  ]);

  const mapaColumna = Object.fromEntries(porColumna.map((c) => [c._id, c]));
  const columnasOrdenadas = [...cliente.columnas].sort((a, b) => a.posicion - b.posicion);
  const embudo = columnasOrdenadas.map((col) => ({
    columna_id: col.id,
    nombre: col.nombre,
    cantidad: mapaColumna[col.id]?.cantidad || 0,
    monto_total: mapaColumna[col.id]?.monto_total || 0
  }));

  // Últimos 12 meses, con los meses sin consultas en cero (para que el gráfico no "salte").
  const hoy = new Date();
  hoy.setDate(1);
  const mesesClaves = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    mesesClaves.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 11, 1);
  const porMes = await fichasCol.aggregate([
    { $match: { cliente_id: clienteId, fecha_hora_recibido: { $gte: desde } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$fecha_hora_recibido' } },
        monto_total: { $sum: { $ifNull: ['$monto', 0] } },
        cantidad: { $sum: 1 }
      }
    }
  ]).toArray();
  const mapaMes = Object.fromEntries(porMes.map((m) => [m._id, m]));
  const valorPorMes = mesesClaves.map((mes) => ({
    mes,
    monto_total: mapaMes[mes]?.monto_total || 0,
    cantidad: mapaMes[mes]?.cantidad || 0
  }));

  const totalLeads = embudo.reduce((acc, c) => acc + c.cantidad, 0);
  const valorTotal = embudo.reduce((acc, c) => acc + c.monto_total, 0);
  const ultimaColumna = embudo[embudo.length - 1];
  const tasaConversion = totalLeads > 0 ? (ultimaColumna.cantidad / totalLeads) * 100 : 0;

  res.json({
    kpis: { total_leads: totalLeads, valor_total: valorTotal, tasa_conversion: tasaConversion, nombre_ultima_columna: ultimaColumna?.nombre || '' },
    embudo,
    valor_por_mes: valorPorMes,
    origen: porOrigen.map((o) => ({ origen: o._id, cantidad: o.cantidad })),
    departamento: porDepartamento.map((d) => ({ departamento: d._id, cantidad: d.cantidad }))
  });
}));

module.exports = router;
