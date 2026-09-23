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
  console.log('CRM conectado a MongoDB Atlas.');
}

async function ensureIndexes() {
  await db.collection('clientes').createIndex({ slug: 1 }, { unique: true });
  await db.collection('clientes').createIndex({ whatsapp_phone_number_id: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, columna_id: 1, posicion: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, contacto: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, whatsapp_wa_id: 1 });
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

async function crearCliente({ slug, nombre, email_notificacion, admin_password }) {
  const password_hash = bcrypt.hashSync(admin_password, 10);
  const doc = {
    slug,
    nombre,
    email_notificacion: email_notificacion || '',
    whatsapp_phone_number_id: '',
    whatsapp_display_phone: '',
    admin_password_hash: password_hash,
    columnas: COLUMNAS_DEFAULT,
    created_at: new Date()
  };
  const { insertedId } = await getDb().collection('clientes').insertOne(doc);
  return { _id: insertedId, ...doc };
}

module.exports = { connect, getDb, ObjectId, crearCliente, COLUMNAS_DEFAULT };
