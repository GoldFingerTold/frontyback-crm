// Panel de super-admin (solo FrontyBack, no los clientes): dar de alta clientes nuevos,
// conectar su número de WhatsApp y editar las columnas del tablero de cada uno - todo lo
// que antes había que hacer a mano con scripts/crear-cliente.js y tocando Mongo directo.
// Login separado del de los clientes (usuario/contraseña únicos, en el .env, no en Mongo -
// hay un solo super-admin).

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const asyncHandler = require('../asyncHandler');
const mercadopago = require('../services/mercadopago');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en un rato.' }
});

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { usuario, password } = req.body || {};
  const usuarioEsperado = process.env.SUPERADMIN_USER;
  const hashEsperado = process.env.SUPERADMIN_PASSWORD_HASH;

  if (!usuarioEsperado || !hashEsperado) {
    return res.status(500).json({ error: 'El super-admin no está configurado en el servidor.' });
  }
  if (usuario !== usuarioEsperado || !bcrypt.compareSync(password || '', hashEsperado)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  req.session.esSuperadmin = true;
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  req.session.esSuperadmin = false;
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  res.json({ autenticado: Boolean(req.session && req.session.esSuperadmin) });
});

function requireSuperadmin(req, res, next) {
  if (!req.session || !req.session.esSuperadmin) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  next();
}

router.use(requireSuperadmin);

// ---------- Planes y precios ----------
router.get('/planes', asyncHandler(async (req, res) => {
  const planes = await db.getPlanes();
  res.json({ planes });
}));

router.put('/planes/:id', asyncHandler(async (req, res) => {
  const { precio_ars, precio_usd_ref, precio_ars_anual, precio_usd_ref_anual } = req.body || {};
  const valores = {
    precio_ars: Number(precio_ars),
    precio_usd_ref: Number(precio_usd_ref),
    precio_ars_anual: Number(precio_ars_anual),
    precio_usd_ref_anual: Number(precio_usd_ref_anual)
  };
  for (const [campo, valor] of Object.entries(valores)) {
    if (!Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ error: `El campo "${campo}" tiene que ser un número mayor a 0.` });
    }
  }
  const result = await db.getDb().collection('planes').updateOne(
    { id: req.params.id },
    { $set: valores }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe ese plan.' });
  res.json({ ok: true });
}));

router.get('/clientes', asyncHandler(async (req, res) => {
  // Las contraseñas ya no viven acá (están en "usuarios", una por persona), así que no
  // hace falta excluir ningún campo sensible al listar los clientes.
  const clientes = await db.getDb().collection('clientes')
    .find({})
    .sort({ created_at: -1 })
    .toArray();
  res.json({ clientes });
}));

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

router.post('/clientes', asyncHandler(async (req, res) => {
  const { slug, nombre, email_notificacion, password } = req.body || {};
  const slugLimpio = String(slug || '').trim().toLowerCase();
  const nombreLimpio = String(nombre || '').trim();

  if (!slugLimpio || !nombreLimpio || !password) {
    return res.status(400).json({ error: 'Faltan datos (usuario, nombre y contraseña son obligatorios).' });
  }
  if (!SLUG_RE.test(slugLimpio)) {
    return res.status(400).json({ error: 'El usuario solo puede tener minúsculas, números y guiones, y no puede empezar ni terminar con guión.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'La contraseña tiene que tener al menos 8 caracteres.' });
  }

  const existente = await db.getDb().collection('clientes').findOne({ slug: slugLimpio });
  if (existente) return res.status(409).json({ error: 'Ya existe un cliente con ese usuario.' });

  const cliente = await db.crearCliente({
    slug: slugLimpio,
    nombre: nombreLimpio,
    email_notificacion: String(email_notificacion || '').trim(),
    admin_password: password
  });

  res.json({
    ok: true,
    cliente: { _id: cliente._id, slug: cliente.slug, nombre: cliente.nombre }
  });
}));

// Cada plan limita cuántas cuentas de WhatsApp puede tener conectadas un cliente a la vez
// (server/db.js, PLANES_DEFAULT) - sin plan asignado, se asume el tope más chico (1) para
// no dejar conectar de más por error antes de que Hugo le asigne un plan de verdad.
async function maxWhatsappDeCliente(cliente) {
  if (!cliente.plan) return 1;
  const planes = await db.getPlanes();
  return planes[cliente.plan]?.max_whatsapp ?? 1;
}

// Link personalizado del Embedded Signup alojado por Meta: la página donde el cliente
// autoriza su WhatsApp con un par de clics. El "state" lleva el slug para que
// server/routes/public.js (GET /whatsapp/callback) sepa a qué cliente conectarlo cuando
// Meta redirige de vuelta.
router.get('/clientes/:id/whatsapp-link', asyncHandler(async (req, res) => {
  const cliente = await db.getDb().collection('clientes').findOne({ _id: new db.ObjectId(req.params.id) });
  if (!cliente) return res.status(404).json({ error: 'No existe ese cliente.' });

  const params = new URLSearchParams({
    app_id: process.env.WHATSAPP_APP_ID || '',
    config_id: process.env.WHATSAPP_CONFIG_ID || '',
    state: cliente.slug
  });
  res.json({ link: `https://business.facebook.com/messaging/whatsapp/onboard/?${params}` });
}));

router.post('/clientes/:id/whatsapp', asyncHandler(async (req, res) => {
  const mongo = db.getDb();
  const clienteId = new db.ObjectId(req.params.id);
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  if (!cliente) return res.status(404).json({ error: 'No existe ese cliente.' });

  const phoneNumberId = String(req.body?.phone_number_id || '').trim();
  const etiqueta = String(req.body?.etiqueta || '').trim().slice(0, 40);
  if (!phoneNumberId) return res.status(400).json({ error: 'Falta el Phone Number ID.' });

  const numeros = cliente.whatsapp_numeros || [];
  if (numeros.some((n) => n.phone_number_id === phoneNumberId)) {
    return res.status(409).json({ error: 'Ese número ya está conectado a este cliente.' });
  }
  const max = await maxWhatsappDeCliente(cliente);
  if (numeros.length >= max) {
    return res.status(400).json({ error: `Este cliente ya tiene el máximo de ${max} cuenta${max === 1 ? '' : 's'} de WhatsApp de su plan.` });
  }

  await mongo.collection('clientes').updateOne(
    { _id: clienteId },
    { $push: { whatsapp_numeros: { phone_number_id: phoneNumberId, etiqueta } } }
  );
  res.json({ ok: true });
}));

router.delete('/clientes/:id/whatsapp/:phoneNumberId', asyncHandler(async (req, res) => {
  const result = await db.getDb().collection('clientes').updateOne(
    { _id: new db.ObjectId(req.params.id) },
    { $pull: { whatsapp_numeros: { phone_number_id: req.params.phoneNumberId } } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe ese cliente.' });
  res.json({ ok: true });
}));

// Las columnas se identifican por "id" (estable, nunca cambia una vez creada una columna -
// solo se le puede cambiar el nombre y la posición). Si una columna se borra, las fichas
// que tenía adentro NO desaparecen: se migran a la primera columna que quede, para que
// nunca se pierda de vista una consulta real por editar el tablero.
router.put('/clientes/:id/columnas', asyncHandler(async (req, res) => {
  const { columnas } = req.body || {};
  const clienteId = new db.ObjectId(req.params.id);

  if (!Array.isArray(columnas) || columnas.length === 0) {
    return res.status(400).json({ error: 'Tiene que haber al menos una columna.' });
  }
  for (const c of columnas) {
    if (!c || typeof c.id !== 'string' || !c.id.trim() || typeof c.nombre !== 'string' || !c.nombre.trim()) {
      return res.status(400).json({ error: 'Cada columna necesita un id y un nombre.' });
    }
  }
  const idsNuevos = columnas.map((c) => c.id.trim());
  if (new Set(idsNuevos).size !== idsNuevos.length) {
    return res.status(400).json({ error: 'Hay columnas con el mismo id repetido.' });
  }

  const mongo = db.getDb();
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  if (!cliente) return res.status(404).json({ error: 'No existe ese cliente.' });

  const columnasNormalizadas = columnas.map((c, i) => ({
    id: c.id.trim(),
    nombre: c.nombre.trim().slice(0, 60),
    posicion: i
  }));

  const idsViejos = (cliente.columnas || []).map((c) => c.id);
  const idsBorrados = idsViejos.filter((id) => !idsNuevos.includes(id));

  if (idsBorrados.length > 0) {
    const columnaDestino = columnasNormalizadas[0].id;
    const yaEnDestino = await mongo.collection('fichas').countDocuments({ cliente_id: clienteId, columna_id: columnaDestino });
    let siguientePosicion = yaEnDestino;
    for (const idBorrado of idsBorrados) {
      const fichasAMigrar = await mongo.collection('fichas')
        .find({ cliente_id: clienteId, columna_id: idBorrado })
        .sort({ posicion: 1 })
        .toArray();
      for (const f of fichasAMigrar) {
        await mongo.collection('fichas').updateOne(
          { _id: f._id },
          { $set: { columna_id: columnaDestino, posicion: siguientePosicion } }
        );
        siguientePosicion += 1;
      }
    }
  }

  await mongo.collection('clientes').updateOne(
    { _id: clienteId },
    { $set: { columnas: columnasNormalizadas } }
  );

  res.json({ ok: true, columnas: columnasNormalizadas, fichasMigradas: idsBorrados.length > 0 });
}));

// Para cuando Hugo cobra a mano después de la prueba gratis (o renueva mes a mes): pasa
// el cliente a "activo", o lo marca "vencido" si no pagó.
const ESTADOS_PAGO_VALIDOS = ['prueba', 'activo', 'vencido_gracia', 'vencido_cortado', 'cancelado'];
router.put('/clientes/:id/estado-pago', asyncHandler(async (req, res) => {
  const { estado_pago } = req.body || {};
  if (!ESTADOS_PAGO_VALIDOS.includes(estado_pago)) {
    return res.status(400).json({ error: 'Estado de pago inválido.' });
  }
  const result = await db.getDb().collection('clientes').updateOne(
    { _id: new db.ObjectId(req.params.id) },
    { $set: { estado_pago } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe ese cliente.' });
  res.json({ ok: true });
}));

// Edición general de un cliente ya creado (nombre, email, plan/precio/frecuencia pactados,
// y el tope mensual de audios de WhatsApp - pensado sobre todo para ajustarlo en cuentas
// que vinieron con un código 100% gratis). Cada campo es opcional: solo se actualiza el que
// venga en el body, así el formulario del panel puede mandar nada más que lo que cambió.
const PLANES_VALIDOS = ['esencial', 'completo', 'premium', 'elite'];
router.put('/clientes/:id', asyncHandler(async (req, res) => {
  const { nombre, email_notificacion, plan, precio_pactado, frecuencia_pago, limite_audios_mes } = req.body || {};
  const clienteId = new db.ObjectId(req.params.id);
  const set = {};

  if (nombre !== undefined) {
    const nombreLimpio = String(nombre).trim();
    if (!nombreLimpio) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
    set.nombre = nombreLimpio;
  }
  if (email_notificacion !== undefined) {
    set.email_notificacion = String(email_notificacion).trim();
  }
  if (plan !== undefined) {
    if (plan !== null && !PLANES_VALIDOS.includes(plan)) return res.status(400).json({ error: 'Plan inválido.' });
    set.plan = plan || null;
  }
  if (precio_pactado !== undefined) {
    const precio = Number(precio_pactado);
    if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'El precio tiene que ser un número de 0 para arriba.' });
    set.precio_pactado = precio;
  }
  if (frecuencia_pago !== undefined) {
    if (frecuencia_pago !== 'mensual' && frecuencia_pago !== 'anual') return res.status(400).json({ error: 'Frecuencia inválida.' });
    set.frecuencia_pago = frecuencia_pago;
  }
  if (limite_audios_mes !== undefined) {
    if (limite_audios_mes === null || limite_audios_mes === '') {
      set.limite_audios_mes = null;
    } else {
      const limite = Number(limite_audios_mes);
      if (!Number.isFinite(limite) || limite < 0) return res.status(400).json({ error: 'El límite de audios tiene que ser un número de 0 para arriba (o vacío para ilimitado).' });
      set.limite_audios_mes = limite;
    }
  }

  const result = await db.getDb().collection('clientes').updateOne({ _id: clienteId }, { $set: set });
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe ese cliente.' });
  res.json({ ok: true });
}));

// Borra un cliente y todo lo suyo (fichas, contador de uso de audios). Si tenía una
// suscripción de Mercado Pago pendiente o autorizada, se cancela de paso - si no, Mercado
// Pago seguiría intentando cobrarle a una cuenta que ya no existe en el CRM.
router.delete('/clientes/:id', asyncHandler(async (req, res) => {
  const clienteId = new db.ObjectId(req.params.id);
  const mongo = db.getDb();
  const cliente = await mongo.collection('clientes').findOne({ _id: clienteId });
  if (!cliente) return res.status(404).json({ error: 'No existe ese cliente.' });

  if (cliente.mercadopago_preapproval_id) {
    try {
      await mercadopago.cancelarSuscripcion(cliente.mercadopago_preapproval_id);
    } catch (err) {
      console.error('No se pudo cancelar la suscripción de Mercado Pago al borrar el cliente:', err.message);
    }
  }

  await mongo.collection('fichas').deleteMany({ cliente_id: clienteId });
  await mongo.collection('uso_audio_mensual').deleteMany({ cliente_id: clienteId });
  await mongo.collection('usuarios').deleteMany({ cliente_id: clienteId });
  await mongo.collection('clientes').deleteOne({ _id: clienteId });
  res.json({ ok: true });
}));

// ---------- Códigos de descuento / afiliados (closers) ----------
// Cada código le da un % de descuento al cliente que lo usa al anotarse desde la landing, y
// deja registrado un % de comisión para quien lo trajo (el "closer") - Hugo calcula y paga
// esas comisiones a mano a fin de mes, mirando qué clientes activos tienen cada código.

router.get('/codigos', asyncHandler(async (req, res) => {
  const codigos = await db.getDb().collection('codigos').find({}).sort({ created_at: -1 }).toArray();
  res.json({ codigos });
}));

const CODIGO_RE = /^[A-Z0-9]{3,20}$/;

router.post('/codigos', asyncHandler(async (req, res) => {
  const { codigo, nombre_closer, contacto, descuento_pct, comision_pct, usos_maximos } = req.body || {};
  const codigoLimpio = String(codigo || '').trim().toUpperCase();
  const nombreLimpio = String(nombre_closer || '').trim();
  const descuento = Number(descuento_pct);
  const comision = Number(comision_pct);
  // Vacío/0 = sin límite de usos. Para un código de uso personal (no transferible), poner 1.
  const usosMax = usos_maximos === '' || usos_maximos === null || usos_maximos === undefined
    ? null
    : Number(usos_maximos);

  if (!CODIGO_RE.test(codigoLimpio)) {
    return res.status(400).json({ error: 'El código tiene que tener entre 3 y 20 letras/números, sin espacios.' });
  }
  if (!nombreLimpio) return res.status(400).json({ error: 'Falta el nombre del closer.' });
  if (!Number.isFinite(descuento) || descuento < 0 || descuento > 100) {
    return res.status(400).json({ error: 'El descuento tiene que ser un número entre 0 y 100.' });
  }
  if (!Number.isFinite(comision) || comision < 0 || comision > 100) {
    return res.status(400).json({ error: 'La comisión tiene que ser un número entre 0 y 100.' });
  }
  if (usosMax !== null && (!Number.isFinite(usosMax) || usosMax < 1)) {
    return res.status(400).json({ error: 'El límite de usos tiene que ser un número de 1 para arriba (o vacío para ilimitado).' });
  }

  const existente = await db.getDb().collection('codigos').findOne({ codigo: codigoLimpio });
  if (existente) return res.status(409).json({ error: 'Ya existe un código con ese nombre.' });

  const doc = {
    codigo: codigoLimpio,
    nombre_closer: nombreLimpio,
    contacto: String(contacto || '').trim(),
    descuento_pct: descuento,
    comision_pct: comision,
    usos_maximos: usosMax,
    usos_actuales: 0,
    activo: true,
    created_at: new Date()
  };
  await db.getDb().collection('codigos').insertOne(doc);
  res.json({ ok: true, codigo: doc });
}));

router.put('/codigos/:id/activo', asyncHandler(async (req, res) => {
  const { activo } = req.body || {};
  const result = await db.getDb().collection('codigos').updateOne(
    { _id: new db.ObjectId(req.params.id) },
    { $set: { activo: Boolean(activo) } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ error: 'No existe ese código.' });
  res.json({ ok: true });
}));

module.exports = router;
