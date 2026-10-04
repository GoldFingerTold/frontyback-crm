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
  await migrarWhatsappNumeros();
  console.log('CRM conectado a MongoDB Atlas.');
}

async function ensureIndexes() {
  await db.collection('clientes').createIndex({ slug: 1 }, { unique: true });
  await db.collection('clientes').createIndex({ 'whatsapp_numeros.phone_number_id': 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, columna_id: 1, posicion: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, contacto: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, whatsapp_wa_id: 1 });
  await db.collection('codigos').createIndex({ codigo: 1 }, { unique: true });
  await db.collection('planes').createIndex({ id: 1 }, { unique: true });
  await db.collection('uso_audio_mensual').createIndex({ cliente_id: 1, mes: 1 }, { unique: true });
}

// Planes públicos que se muestran en la landing de ventas (index.html) y se ofrecen en
// el alta por autoservicio. Viven en Mongo (no hardcodeados) para que Hugo pueda ajustar
// el precio en pesos desde el super-admin cuando se mueva el dólar, sin tocar código.
// precio_usd_ref es solo de referencia para mostrar "≈ USD X" - lo que se cobra de
// verdad (en MercadoPago, y lo que queda guardado en cada cliente) es el *_ars.
// Cada plan tiene precio mensual y un precio anual (pagando el año adelantado, 2 meses
// gratis respecto de pagar mes a mes), y max_whatsapp: cuántas cuentas de WhatsApp puede
// conectar un cliente con ese plan (server/routes/superadmin.js lo hace cumplir al agregar
// un número nuevo).
const PLANES_DEFAULT = [
  {
    id: 'esencial',
    nombre: 'Esencial',
    precio_ars: 15000,
    precio_usd_ref: 10,
    precio_ars_anual: 150000,
    precio_usd_ref_anual: 100,
    max_whatsapp: 1,
    descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, y tablero de seguimiento.',
    features: ['Formulario y WhatsApp (texto)', 'Respuesta automática al instante', 'Tablero Kanban', 'Hasta 150 consultas por mes', '1 cuenta de WhatsApp conectada']
  },
  {
    id: 'completo',
    nombre: 'Profesional',
    precio_ars: 30000,
    precio_usd_ref: 20,
    precio_ars_anual: 300000,
    precio_usd_ref_anual: 200,
    max_whatsapp: 5,
    descripcion: 'Todo lo del plan Esencial, más WhatsApp con audio, columnas a medida y hasta 5 cuentas de WhatsApp.',
    features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Consultas ilimitadas', 'Hasta 5 cuentas de WhatsApp conectadas']
  },
  {
    id: 'premium',
    nombre: 'Premium',
    precio_ars: 45000,
    precio_usd_ref: 30,
    precio_ars_anual: 450000,
    precio_usd_ref_anual: 300,
    max_whatsapp: 20,
    descripcion: 'Todo lo del plan Profesional, pensado para negocios con varias sucursales o líneas de WhatsApp.',
    features: ['Todo lo del plan Profesional', 'Hasta 20 cuentas de WhatsApp conectadas', 'Ideal para varias sucursales o equipos']
  }
];

async function sembrarPlanes() {
  const col = db.collection('planes');
  for (const plan of PLANES_DEFAULT) {
    await col.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true });
    // Si el plan ya existía de antes (por ejemplo, antes de agregar los precios anuales o
    // el tope de WhatsApp), completa solo los campos que todavía no tiene - nunca pisa un
    // precio que Hugo ya haya ajustado a mano desde el super-admin.
    await col.updateOne(
      { id: plan.id, precio_ars_anual: { $exists: false } },
      { $set: { precio_ars_anual: plan.precio_ars_anual, precio_usd_ref_anual: plan.precio_usd_ref_anual } }
    );
    await col.updateOne(
      { id: plan.id, max_whatsapp: { $exists: false } },
      { $set: { max_whatsapp: plan.max_whatsapp } }
    );
  }
  // El plan "completo" pasó a llamarse "Profesional" (ahora que el diferencial principal
  // frente a Esencial es la cantidad de cuentas de WhatsApp, no solo el audio) - una sola
  // vez, no pisa el nombre si Hugo ya lo cambió a otra cosa.
  await col.updateOne(
    { id: 'completo', nombre: 'Completo' },
    {
      $set: {
        nombre: 'Profesional',
        descripcion: 'Todo lo del plan Esencial, más WhatsApp con audio, columnas a medida y hasta 5 cuentas de WhatsApp.',
        features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Consultas ilimitadas', 'Hasta 5 cuentas de WhatsApp conectadas']
      }
    }
  );
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

// Lo llama el webhook de Mercado Pago cuando se autoriza una suscripción o se cobra una
// cuota: el cliente queda activo y se borran los plazos de prueba/gracia (si los tenía).
async function activarPorPago(clienteId, { preapprovalId } = {}) {
  const set = { estado_pago: 'activo', prueba_termina: null, gracia_termina: null };
  if (preapprovalId) set.mercadopago_preapproval_id = preapprovalId;
  await getDb().collection('clientes').updateOne({ _id: clienteId }, { $set: set });
}

// Lo llama el webhook de Mercado Pago cuando Mercado Pago cancela la suscripción porque no
// pudo cobrarle al cliente (tarjeta rechazada varias veces) - entra al mismo período de
// gracia de 7 días que el vencimiento de la prueba gratis.
async function cortarPorFaltaDePago(clienteId) {
  const gracia_termina = new Date(Date.now() + DIAS_GRACIA * 24 * 60 * 60 * 1000);
  await getDb().collection('clientes').updateOne(
    { _id: clienteId, estado_pago: { $ne: 'vencido_cortado' } },
    { $set: { estado_pago: 'vencido_gracia', gracia_termina } }
  );
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

// Una cuenta dada de alta con un código 100% gratis no deja ninguna facturación que
// compense lo que cuesta transcribir y responder con voz por WhatsApp (son las dos únicas
// funciones de este CRM con costo variable por uso - todo lo demás es gratis o de costo
// fijo). Por eso a esas cuentas se les pone un tope mensual de audios por defecto, editable
// por cliente desde el super-admin si hace falta más.
const LIMITE_AUDIOS_CODIGO_GRATIS = 30;

// origen: 'superadmin' (alta manual, sin período de prueba, se asume ya acordado con
// Hugo) | 'landing' (autoservicio, arranca en prueba gratis).
async function crearCliente({
  slug,
  nombre,
  email_notificacion,
  admin_password,
  plan = null,
  precio_pactado = 0,
  frecuencia_pago = 'mensual',
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
    whatsapp_numeros: [],
    admin_password_hash: password_hash,
    columnas: COLUMNAS_DEFAULT,
    plan,
    precio_pactado,
    frecuencia_pago,
    origen,
    codigo_referido,
    descuento_pct_aplicado,
    comision_pct_aplicada,
    limite_audios_mes: descuento_pct_aplicado >= 100 ? LIMITE_AUDIOS_CODIGO_GRATIS : null,
    estado_pago: esAltaAutoservicio ? 'prueba' : 'activo',
    prueba_termina: esAltaAutoservicio
      ? new Date(ahora.getTime() + DIAS_PRUEBA_GRATIS * 24 * 60 * 60 * 1000)
      : null,
    created_at: ahora
  };
  const { insertedId } = await getDb().collection('clientes').insertOne(doc);
  return { _id: insertedId, ...doc };
}

// Cuenta cuántos audios de WhatsApp ya se transcribieron este mes para un cliente -
// contador aparte de "fichas" porque una misma persona que manda varios audios no genera
// una ficha nueva por cada uno (se deduplican por contacto), así que contar fichas
// subestimaría el uso real.
function mesActual() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

async function contarUsoAudioEsteMes(clienteId) {
  const doc = await getDb().collection('uso_audio_mensual').findOne({ cliente_id: clienteId, mes: mesActual() });
  return doc?.cantidad || 0;
}

async function registrarUsoAudio(clienteId) {
  await getDb().collection('uso_audio_mensual').updateOne(
    { cliente_id: clienteId, mes: mesActual() },
    { $inc: { cantidad: 1 } },
    { upsert: true }
  );
}

// Antes cada cliente tenía un solo whatsapp_phone_number_id - ahora puede tener varios,
// en whatsapp_numeros. Convierte una sola vez los clientes viejos que todavía no tienen
// ese array, sin perder el número que ya tenían conectado.
async function migrarWhatsappNumeros() {
  const col = db.collection('clientes');
  const viejos = await col.find({ whatsapp_numeros: { $exists: false } }).toArray();
  for (const c of viejos) {
    const numeros = c.whatsapp_phone_number_id
      ? [{ phone_number_id: c.whatsapp_phone_number_id, etiqueta: '' }]
      : [];
    await col.updateOne(
      { _id: c._id },
      { $set: { whatsapp_numeros: numeros }, $unset: { whatsapp_phone_number_id: '', whatsapp_display_phone: '' } }
    );
  }
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
  estadoPermiteRespuesta,
  activarPorPago,
  cortarPorFaltaDePago,
  contarUsoAudioEsteMes,
  registrarUsoAudio
};
