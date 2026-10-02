// Conexión a MongoDB Atlas. CRM multi-cliente: cada negocio que contrata el servicio es
// un documento en "clientes" (con su propio login y su propio número de WhatsApp
// conectado), y cada consulta que le llega (por formulario o WhatsApp) es una "ficha" en
// la colección "fichas", asociada a ese cliente.

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    'Falta la variable de entorno MONGODB_URI. Copiá .env.example a .env y completala antes de arrancar.'
  );
}

const client = new MongoClient(uri);
let db = null;

function getDb() {
  if (!db) throw new Error('La base de datos todavía no está conectada. Llamá a connect() primero.');
  return db;
}

async function connect() {
  await client.connect();
  db = client.db();
  await ensureIndexes();
  await sembrarPlanes();
  console.log('CRM conectado a MongoDB Atlas.');
}

async function ensureIndexes() {
  await db.collection('clientes').createIndex({ slug: 1 }, { unique: true });
  await db.collection('clientes').createIndex({ whatsapp_phone_number_id: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, columna_id: 1, posicion: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, contacto: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, whatsapp_wa_id: 1 });
  await db.collection('codigos').createIndex({ codigo: 1 }, { unique: true });
  await db.collection('planes').createIndex({ id: 1 }, { unique: true });
}

// Planes públicos que se muestran en la landing de ventas (planes.html) y se ofrecen en
// el alta por autoservicio. Viven en Mongo (no hardcodeados) para que Hugo pueda ajustar
// el precio en pesos desde el super-admin cuando se mueva el dólar, sin tocar código.
// precio_usd_ref es solo de referencia para mostrar "≈ USD X" - lo que se cobra de
// verdad (en MercadoPago, y lo que queda guardado en cada cliente) es precio_ars.
const PLANES_DEFAULT = [
  {
    id: 'esencial',
    nombre: 'Esencial',
    precio_ars: 15000,
    precio_usd_ref: 10,
    descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, y tablero de seguimiento.',
    features: ['Formulario y WhatsApp (texto)', 'Respuesta automática al instante', 'Tablero Kanban', 'Hasta 150 consultas por mes']
  },
  {
    id: 'completo',
    nombre: 'Completo',
    precio_ars: 30000,
    precio_usd_ref: 20,
    descripcion: 'Todo lo del plan Esencial, más WhatsApp con audio y columnas a medida.',
    features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Consultas ilimitadas']
  }
];

async function sembrarPlanes() {
  const col = db.collection('planes');
  for (const plan of PLANES_DEFAULT) {
    await col.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true });
  }
}

async function getPlanes() {
  const lista = await db.collection('planes').find({}).sort({ precio_ars: 1 }).toArray();
  const mapa = {};
  for (const p of lista) mapa[p.id] = p;
  return mapa;
}

const DIAS_PRUEBA_GRATIS = 7;
const DIAS_GRACIA = 7;

// Qué puede hacer cada estado de pago cuando llega una consulta nueva (formulario o
// WhatsApp):
// - prueba / activo: se guarda la ficha y se manda la respuesta automática, todo normal.
// - vencido_gracia: se guarda la ficha (no se pierde el lead del cliente final), pero NO
//   se manda respuesta automática - esa es la parte "paga" que se corta primero.
// - vencido_cortado / cancelado: no se guarda nada, el servicio está completamente
//   detenido hasta que vuelva a pagar.
function estadoPermiteCaptura(estadoPago) {
  return estadoPago !== 'vencido_cortado' && estadoPago !== 'cancelado';
}
function estadoPermiteRespuesta(estadoPago) {
  return estadoPago === 'prueba' || estadoPago === 'activo';
}

// Columnas por defecto del tablero de un cliente nuevo - se pueden editar después desde
// el panel (agregar, renombrar o borrar columnas), esto es solo el punto de partida.
const COLUMNAS_DEFAULT = [
  { id: 'nuevo', nombre: 'Nuevos', posicion: 0 },
  { id: 'contactado', nombre: 'Contactados', posicion: 1 },
  { id: 'negociacion', nombre: 'En negociación', posicion: 2 },
  { id: 'ganado', nombre: 'Venta concretada', posicion: 3 },
  { id: 'perdido', nombre: 'No avanzó', posicion: 4 }
];

// origen: 'superadmin' (alta manual, sin período de prueba, se asume ya acordado con
// Hugo) | 'landing' (autoservicio, arranca en prueba gratis).
async function crearCliente({
  slug,
  nombre,
  email_notificacion,
  admin_password,
  plan = null,
  precio_mensual = 0,
  origen = 'superadmin',
  codigo_referido = null,
  descuento_pct_aplicado = 0,
  comision_pct_aplicada = 0
}) {
  const password_hash = bcrypt.hashSync(admin_password, 10);
  const ahora = new Date();
  const esAltaAutoservicio = origen === 'landing';

  const doc = {
    slug,
    nombre,
    email_notificacion: email_notificacion || '',
    whatsapp_phone_number_id: '',
    whatsapp_display_phone: '',
    admin_password_hash: password_hash,
    columnas: COLUMNAS_DEFAULT,
    plan,
    precio_mensual,
    origen,
    codigo_referido,
    descuento_pct_aplicado,
    comision_pct_aplicada,
    estado_pago: esAltaAutoservicio ? 'prueba' : 'activo',
    prueba_termina: esAltaAutoservicio
      ? new Date(ahora.getTime() + DIAS_PRUEBA_GRATIS * 24 * 60 * 60 * 1000)
      : null,
    created_at: ahora
  };
  const { insertedId } = await getDb().collection('clientes').insertOne(doc);
  return { _id: insertedId, ...doc };
}

module.exports = {
  connect,
  getDb,
  ObjectId,
  crearCliente,
  COLUMNAS_DEFAULT,
  getPlanes,
  DIAS_PRUEBA_GRATIS,
  DIAS_GRACIA,
  estadoPermiteCaptura,
  estadoPermiteRespuesta
};
