// Revisa periódicamente el estado de pago de cada cliente y los va pasando de "prueba" a
// "vencido_gracia" (7 días de margen, sigue guardando leads pero sin respuesta automática)
// y de ahí a "vencido_cortado" (servicio detenido del todo) - sin que nadie tenga que
// hacerlo a mano. Si en algún momento paga, lo reactiva el webhook de MercadoPago, no esto.
//
// Además manda por email el link de pago antes de cada vencimiento, para que el cliente no
// dependa de entrar al tablero para enterarse: un recordatorio unos días antes de que
// termine la prueba, un aviso apenas arranca el período de gracia, y un último aviso antes
// de que se corte el servicio del todo.

const db = require('../db');
const email = require('./email');
const pagos = require('./pagos');

const DIAS_RECORDATORIO = 2;

async function mandarAvisoDePago(cliente, tipo) {
  try {
    const link = await pagos.obtenerOCrearLinkDePago(cliente);
    if (!link) return false; // sin plan asignado, no hay nada que cobrar todavía
    await email.enviarAvisoPago({ emailDestinatario: cliente.email_notificacion, tipo, link });
    return true;
  } catch (err) {
    console.error(`No se pudo mandar el aviso de pago (${tipo}) a ${cliente.slug}:`, err.message);
    return false;
  }
}

async function revisarEstadosPago() {
  const mongo = db.getDb();
  const ahora = new Date();
  const limiteRecordatorio = new Date(ahora.getTime() + DIAS_RECORDATORIO * 24 * 60 * 60 * 1000);

  // Recordatorio unos días antes de que termine la prueba gratis.
  const porVencerPrueba = await mongo.collection('clientes').find({
    estado_pago: 'prueba',
    prueba_termina: { $lte: limiteRecordatorio },
    aviso_prueba_enviado: { $ne: true }
  }).toArray();
  for (const cliente of porVencerPrueba) {
    if (await mandarAvisoDePago(cliente, 'recordatorio_prueba')) {
      await mongo.collection('clientes').updateOne({ _id: cliente._id }, { $set: { aviso_prueba_enviado: true } });
    }
  }

  // Prueba vencida -> entra en período de gracia, con email avisando en el momento.
  const entranEnGracia = await mongo.collection('clientes').find({
    estado_pago: 'prueba',
    prueba_termina: { $lte: ahora }
  }).toArray();
  if (entranEnGracia.length) {
    await mongo.collection('clientes').updateMany(
      { _id: { $in: entranEnGracia.map((c) => c._id) } },
      {
        $set: {
          estado_pago: 'vencido_gracia',
          gracia_termina: new Date(ahora.getTime() + db.DIAS_GRACIA * 24 * 60 * 60 * 1000)
        }
      }
    );
    for (const cliente of entranEnGracia) {
      await mandarAvisoDePago(cliente, 'inicio_gracia');
    }
  }

  // Último aviso, unos días antes de que se corte el servicio del todo.
  const porCortarse = await mongo.collection('clientes').find({
    estado_pago: 'vencido_gracia',
    gracia_termina: { $lte: limiteRecordatorio },
    aviso_corte_enviado: { $ne: true }
  }).toArray();
  for (const cliente of porCortarse) {
    if (await mandarAvisoDePago(cliente, 'ultimo_aviso')) {
      await mongo.collection('clientes').updateOne({ _id: cliente._id }, { $set: { aviso_corte_enviado: true } });
    }
  }

  const aCortado = await mongo.collection('clientes').updateMany(
    { estado_pago: 'vencido_gracia', gracia_termina: { $lte: ahora } },
    { $set: { estado_pago: 'vencido_cortado' } }
  );

  if (entranEnGracia.length || aCortado.modifiedCount) {
    console.log(
      `Ciclo de pagos: ${entranEnGracia.length} entraron en período de gracia, ${aCortado.modifiedCount} se cortaron del todo.`
    );
  }
}

function iniciar() {
  const chequear = () => revisarEstadosPago().catch((err) => console.error('Error revisando estados de pago:', err));
  chequear();
  setInterval(chequear, 60 * 60 * 1000); // cada 1 hora alcanza de sobra, esto no es urgente al minuto
}

module.exports = { iniciar, revisarEstadosPago };
