// Cobro de seña de Turnos vía la CUENTA PROPIA de Mercado Pago de cada negocio (OAuth -
// "Connect"), no la de FrontyBack. A diferencia de server/services/mercadopago.js (que usa
// el token global de FrontyBack para cobrarle la suscripción del CRM a cada cliente), acá
// cada cliente autoriza una vez a la app de FrontyBack y el dinero de la seña entra directo
// a SU cuenta. Mismo patrón que Google Calendar (server/services/googleCalendar.js):
// getAuthUrl -> intercambiarCodigo -> access_token + refresh_token guardados en el cliente.

const db = require('../db');

const BASE = 'https://api.mercadopago.com';

function config() {
  const clientId = process.env.MERCADOPAGO_CONNECT_CLIENT_ID;
  const clientSecret = process.env.MERCADOPAGO_CONNECT_CLIENT_SECRET;
  const redirectUri = process.env.MERCADOPAGO_CONNECT_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Faltan MERCADOPAGO_CONNECT_CLIENT_ID/CLIENT_SECRET/REDIRECT_URI en el .env.');
  }
  return { clientId, clientSecret, redirectUri };
}

// El "state" es el id del cliente en texto plano, igual que en Google Calendar - no es un
// secreto, solo identifica a qué cuenta del CRM atar la conexión. Pedir el flujo ya
// requiere estar logueado como Gerencia de esa cuenta.
function getAuthUrl(clienteId) {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: redirectUri,
    state: String(clienteId)
  });
  return `https://auth.mercadopago.com.ar/authorization?${params}`;
}

async function intercambiarCodigo(code) {
  const { clientId, clientSecret, redirectUri } = config();
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error canjeando el código de Mercado Pago: ${JSON.stringify(data)}`);
  return data; // { access_token, refresh_token, user_id, public_key, expires_in, ... }
}

async function refrescarToken(refreshToken) {
  const { clientId, clientSecret } = config();
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error refrescando el token de Mercado Pago: ${JSON.stringify(data)}`);
  return data; // trae access_token Y refresh_token nuevos (a diferencia de Google, MP rota los dos)
}

// A diferencia de Google (1hs de vigencia), el access_token de Mercado Pago dura 180 días -
// de todos modos se guarda la fecha de vencimiento y se refresca solo si hace falta, para
// no depender de acordarse de renovarlo a mano.
async function getAccessTokenValido(cliente) {
  if (!cliente.mercadopago_connect_refresh_token) return null;

  const vigente = cliente.mercadopago_connect_token_expira && new Date(cliente.mercadopago_connect_token_expira) > new Date();
  if (vigente) return cliente.mercadopago_connect_access_token;

  const data = await refrescarToken(cliente.mercadopago_connect_refresh_token);
  const expira = new Date(Date.now() + (data.expires_in - 3600) * 1000); // 1hs de margen
  await db.getDb().collection('clientes').updateOne(
    { _id: cliente._id },
    {
      $set: {
        mercadopago_connect_access_token: data.access_token,
        mercadopago_connect_refresh_token: data.refresh_token,
        mercadopago_connect_token_expira: expira
      }
    }
  );
  return data.access_token;
}

// Checkout Pro: un link hosteado por Mercado Pago donde el cliente final carga la tarjeta
// y paga la seña. El dinero entra a la cuenta del NEGOCIO (el access_token es el de él, no
// el de FrontyBack). external_reference es el id del turno, para poder encontrarlo de
// nuevo cuando llega la notificación del webhook (server/routes/webhooks.js).
async function crearPreferenciaSeña(cliente, turno, monto) {
  const accessToken = await getAccessTokenValido(cliente);
  if (!accessToken) throw new Error('Este negocio todavía no conectó su cuenta de Mercado Pago.');

  const body = {
    items: [{
      title: `Seña - ${turno.servicio_nombre}`,
      quantity: 1,
      unit_price: monto,
      currency_id: 'ARS'
    }],
    external_reference: String(turno._id),
    // El id del turno va también como query param del webhook (no solo en
    // external_reference) - así, cuando llegue la notificación, se puede encontrar el
    // turno (y de ahí el cliente, y de ahí qué access_token usar para pedirle el pago a la
    // API de Mercado Pago) sin tener que adivinar de qué cuenta es antes de consultar nada.
    notification_url: `https://crm.frontyback.com/webhook/mercadopago-turno?turno_id=${turno._id}`,
    back_urls: {
      success: `https://crm.frontyback.com/mi-turno.html?token=${turno.token_gestion}&pago=ok`,
      pending: `https://crm.frontyback.com/mi-turno.html?token=${turno.token_gestion}&pago=pendiente`,
      failure: `https://crm.frontyback.com/mi-turno.html?token=${turno.token_gestion}&pago=error`
    },
    auto_return: 'approved'
  };

  const res = await fetch(`${BASE}/checkout/preferences`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error creando la preferencia de pago: ${JSON.stringify(data)}`);
  return { id: data.id, init_point: data.init_point };
}

// Para confirmar un pago hay que consultarlo con el token del NEGOCIO (el webhook solo
// avisa "pasó algo", nunca hay que confiar en su contenido sin verificar contra la API).
async function obtenerPago(cliente, paymentId) {
  const accessToken = await getAccessTokenValido(cliente);
  if (!accessToken) throw new Error('Este negocio no tiene Mercado Pago conectado.');
  const res = await fetch(`${BASE}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error consultando el pago en Mercado Pago: ${JSON.stringify(data)}`);
  return data;
}

module.exports = { getAuthUrl, intercambiarCodigo, getAccessTokenValido, crearPreferenciaSeña, obtenerPago };
