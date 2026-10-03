// Link de pago de un cliente: lo arma (o reusa el que ya estaba pendiente) a partir de su
// plan y frecuencia. Lo usan tanto el botón "Reactivar ahora" del tablero como los avisos
// automáticos por email del ciclo de pagos - para no duplicar la misma lógica en los dos.

const db = require('../db');
const mercadopago = require('./mercadopago');

async function obtenerOCrearLinkDePago(cliente) {
  if (!cliente.plan) return null;

  if (cliente.mercadopago_preapproval_id) {
    try {
      const existente = await mercadopago.obtenerSuscripcion(cliente.mercadopago_preapproval_id);
      if (existente.status === 'pending' && existente.init_point) {
        return existente.init_point;
      }
    } catch {
      // si falla la consulta (p.ej. quedó un id viejo inválido), se crea una nueva abajo
    }
  }

  const planes = await db.getPlanes();
  const plan = planes[cliente.plan];
  const suscripcion = await mercadopago.crearSuscripcion({
    slug: cliente.slug,
    email: cliente.email_notificacion,
    monto: cliente.precio_pactado || plan?.precio_ars,
    frecuenciaPago: cliente.frecuencia_pago,
    nombrePlan: plan?.nombre || cliente.plan
  });

  await db.getDb().collection('clientes').updateOne(
    { _id: cliente._id },
    { $set: { mercadopago_preapproval_id: suscripcion.id } }
  );

  return suscripcion.init_point;
}

module.exports = { obtenerOCrearLinkDePago };
