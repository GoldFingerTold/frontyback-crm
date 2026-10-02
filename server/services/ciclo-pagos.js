// Revisa periódicamente el estado de pago de cada cliente y los va pasando de "prueba" a
// "vencido_gracia" (7 días de margen, sigue guardando leads pero sin respuesta automática)
// y de ahí a "vencido_cortado" (servicio detenido del todo) - sin que nadie tenga que
// hacerlo a mano. Si en algún momento paga, lo reactiva el webhook de MercadoPago, no esto.

const db = require('../db');

async function revisarEstadosPago() {
  const mongo = db.getDb();
  const ahora = new Date();

  const aGracia = await mongo.collection('clientes').updateMany(
    { estado_pago: 'prueba', prueba_termina: { $lte: ahora } },
    {
      $set: {
        estado_pago: 'vencido_gracia',
        gracia_termina: new Date(ahora.getTime() + db.DIAS_GRACIA * 24 * 60 * 60 * 1000)
      }
    }
  );

  const aCortado = await mongo.collection('clientes').updateMany(
    { estado_pago: 'vencido_gracia', gracia_termina: { $lte: ahora } },
    { $set: { estado_pago: 'vencido_cortado' } }
  );

  if (aGracia.modifiedCount || aCortado.modifiedCount) {
    console.log(
      `Ciclo de pagos: ${aGracia.modifiedCount} entraron en período de gracia, ${aCortado.modifiedCount} se cortaron del todo.`
    );
  }
}

function iniciar() {
  const chequear = () => revisarEstadosPago().catch((err) => console.error('Error revisando estados de pago:', err));
  chequear();
  setInterval(chequear, 60 * 60 * 1000); // cada 1 hora alcanza de sobra, esto no es urgente al minuto
}

module.exports = { iniciar, revisarEstadosPago };
