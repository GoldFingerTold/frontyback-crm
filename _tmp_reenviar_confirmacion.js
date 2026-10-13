require('dotenv').config();
const db = require('./server/db');
const turnos = require('./server/services/turnos');

(async () => {
  await db.connect();
  const mongo = db.getDb();
  const cliente = await mongo.collection('clientes').findOne({ slug: 'wye' });
  const turno = await mongo.collection('turnos').find({ cliente_id: cliente._id }).sort({ created_at: -1 }).limit(1).toArray();
  console.log('turno:', turno[0]);
  const resultado = await turnos.enviarConfirmacion(cliente, turno[0]);
  console.log('resultado:', resultado);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
