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

router.get('/clientes', asyncHandler(async (req, res) => {
  const clientes = await db.getDb().collection('clientes')
    .find({}, { projection: { admin_password_hash: 0 } })
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

router.put('/clientes/:id/whatsapp', asyncHandler(async (req, res) => {
  const { whatsapp_phone_number_id } = req.body || {};
  const result = await db.getDb().collection('clientes').updateOne(
    { _id: new db.ObjectId(req.params.id) },
    { $set: { whatsapp_phone_number_id: String(whatsapp_phone_number_id || '').trim() } }
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

module.exports = router;
