// Simula los webhooks que manda Hotmart, para comprobar que el alta automática y el corte
// por cancelación funcionan, sin tener que esperar una compra real. Llama directo a la
// función que procesa el webhook (no hace un POST HTTP real), así que no hace falta tener
// el servidor corriendo - usa la misma conexión a Mongo que el resto del CRM.
//
// Uso: node scripts/test-hotmart-webhook.js
//
// OJO: el formato del payload simulado acá abajo es el que documenta server/services/
// hotmart.js (el más común, v2.0.0) - en cuanto Hugo tenga un webhook REAL de Hotmart
// (Herramientas -> Webhook -> History, después de una compra o venta de prueba), hay que
// comparar ese payload contra este y ajustar server/services/hotmart.js si difiere.

require('dotenv').config();
const db = require('../server/db');
const { procesarNotificacionHotmart } = require('../server/routes/webhooks');

const EMAIL_PRUEBA = 'test-hotmart@frontyback.com';
const HOTTOK = process.env.HOTMART_WEBHOOK_SECRET;

function payloadCompra({ monto, transaccion, subscriberCode, email = EMAIL_PRUEBA }) {
  return {
    event: 'PURCHASE_APPROVED',
    hottok: HOTTOK,
    data: {
      buyer: { email, name: 'Cliente De Prueba' },
      purchase: { status: 'APPROVED', transaction: transaccion, price: { value: monto, currency_value: 'USD' } },
      subscription: { subscriber: { code: subscriberCode } }
    }
  };
}

function payloadBaja({ subscriberCode, email = EMAIL_PRUEBA }) {
  return {
    event: 'PURCHASE_CANCELED',
    hottok: HOTTOK,
    data: {
      buyer: { email },
      purchase: { status: 'CANCELED' },
      subscription: { subscriber: { code: subscriberCode } }
    }
  };
}

async function limpiar(mongo) {
  const cliente = await mongo.collection('clientes').findOne({ email_notificacion: EMAIL_PRUEBA, pasarela_pago: 'hotmart' });
  if (!cliente) return;
  await mongo.collection('usuarios').deleteMany({ cliente_id: cliente._id });
  await mongo.collection('clientes').deleteOne({ _id: cliente._id });
  console.log(`(limpieza: borrado el cliente de prueba "${cliente.slug}")`);
}

function assert(cond, mensaje) {
  if (!cond) throw new Error(`FALLÓ: ${mensaje}`);
  console.log(`OK: ${mensaje}`);
}

async function main() {
  if (!HOTTOK) {
    console.error('Falta HOTMART_WEBHOOK_SECRET en el .env - no se puede simular el Hottok.');
    process.exit(1);
  }

  await db.connect();
  const mongo = db.getDb();
  await limpiar(mongo); // por si quedó algo de una corrida anterior interrumpida

  console.log('\n--- 1. Hottok inválido: no tiene que pasar nada ---');
  await procesarNotificacionHotmart({ ...payloadCompra({ monto: 10, transaccion: 'HPTEST1', subscriberCode: 'SUBTEST1' }), hottok: 'token-incorrecto' }, {});
  let cliente = await mongo.collection('clientes').findOne({ email_notificacion: EMAIL_PRUEBA });
  assert(!cliente, 'con Hottok inválido no se creó ninguna cuenta');

  console.log('\n--- 2. Compra aprobada ($10 = plan Esencial mensual): tiene que crear la cuenta ---');
  await procesarNotificacionHotmart(payloadCompra({ monto: 10, transaccion: 'HPTEST1', subscriberCode: 'SUBTEST1' }), {});
  cliente = await mongo.collection('clientes').findOne({ email_notificacion: EMAIL_PRUEBA });
  assert(Boolean(cliente), 'se creó la cuenta');
  assert(cliente.plan === 'esencial', `el plan quedó "esencial" (quedó "${cliente?.plan}")`);
  assert(cliente.frecuencia_pago === 'mensual', `la frecuencia quedó "mensual" (quedó "${cliente?.frecuencia_pago}")`);
  assert(cliente.pasarela_pago === 'hotmart', 'pasarela_pago quedó "hotmart"');
  assert(cliente.estado_pago === 'activo', `el estado quedó "activo" (quedó "${cliente?.estado_pago}")`);
  assert(cliente.hotmart_data?.subscriber_code === 'SUBTEST1', 'se guardó el subscriber_code');
  assert(cliente.idioma === 'en', `sin moneda BRL, el idioma quedó "en" (quedó "${cliente?.idioma}")`);

  console.log('\n--- 3. El mismo evento de nuevo (reintento/renovación): NO tiene que duplicar la cuenta ---');
  await procesarNotificacionHotmart(payloadCompra({ monto: 10, transaccion: 'HPTEST1', subscriberCode: 'SUBTEST1' }), {});
  const cantidad = await mongo.collection('clientes').countDocuments({ email_notificacion: EMAIL_PRUEBA });
  assert(cantidad === 1, `sigue habiendo una sola cuenta (hay ${cantidad})`);

  console.log('\n--- 4. Cancelación: tiene que entrar en el período de gracia ---');
  await procesarNotificacionHotmart(payloadBaja({ subscriberCode: 'SUBTEST1' }), {});
  cliente = await mongo.collection('clientes').findOne({ email_notificacion: EMAIL_PRUEBA });
  assert(cliente.estado_pago === 'vencido_gracia', `el estado quedó "vencido_gracia" (quedó "${cliente?.estado_pago}")`);
  assert(Boolean(cliente.gracia_termina), 'se cargó la fecha en que termina la gracia');

  await limpiar(mongo);
  console.log('\nTodo OK.');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n', err.message);
  try {
    await limpiar(db.getDb());
  } catch {
    // si esto también falla, no hay mucho más para hacer acá
  }
  process.exit(1);
});
