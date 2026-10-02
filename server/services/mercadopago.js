// Cobro recurrente automático vía Mercado Pago (Suscripciones / Preapproval API). Un
// "preapproval" es el link que el cliente visita una vez para autorizar el débito
// periódico con su tarjeta - a partir de ahí, Mercado Pago cobra solo en cada ciclo, sin
// que FrontyBack tenga que hacer nada más.

const BASE = 'https://api.mercadopago.com';

function token() {
  const t = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!t) throw new Error('Falta MERCADOPAGO_ACCESS_TOKEN en el .env.');
  return t;
}

async function mpFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Mercado Pago respondió ${res.status}: ${data?.message || JSON.stringify(data)}`);
  }
  return data;
}

// Crea el link de suscripción para un cliente: cuando lo visita y carga su tarjeta, queda
// autorizado el cobro periódico (mensual o anual) por el monto pactado. No cobra nada
// hasta que el cliente lo autoriza ahí.
async function crearSuscripcion({ slug, email, monto, frecuenciaPago, nombrePlan }) {
  const frequency = frecuenciaPago === 'anual' ? 12 : 1;
  const body = {
    reason: `CRM FrontyBack - Plan ${nombrePlan} (${frecuenciaPago === 'anual' ? 'anual' : 'mensual'})`,
    external_reference: slug,
    payer_email: email,
    back_url: 'https://crm.frontyback.com/tablero.html',
    notification_url: 'https://crm.frontyback.com/webhook/mercadopago',
    auto_recurring: {
      frequency,
      frequency_type: 'months',
      transaction_amount: monto,
      currency_id: 'ARS'
    },
    status: 'pending'
  };
  return mpFetch('/preapproval', { method: 'POST', body: JSON.stringify(body) });
}

async function obtenerSuscripcion(id) {
  return mpFetch(`/preapproval/${id}`);
}

async function obtenerPagoAutorizado(id) {
  return mpFetch(`/authorized_payments/${id}`);
}

async function cancelarSuscripcion(id) {
  return mpFetch(`/preapproval/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
}

module.exports = { crearSuscripcion, obtenerSuscripcion, obtenerPagoAutorizado, cancelarSuscripcion };
