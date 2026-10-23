// Leads de campañas de Meta Ads (formularios instantáneos de Facebook/Instagram) - en vez
// de que el negocio tenga que bajar el Excel a mano desde el Administrador de Anuncios
// (y Meta solo lo guarda 90 días), cada lead entra solo como ficha al tablero.

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// El token de página que devuelve el SDK de JavaScript de Meta (FB.login + /me/accounts
// directo en el navegador, public/conectar-meta-ads.html) es de CORTA duración - vence en
// horas. Hay que cambiar el token de USUARIO por uno de larga duración (60 días) antes de
// pedir las páginas: los tokens de página que salen de ahí heredan esa duración larga (en
// la práctica no vencen mientras el usuario no revoque el acceso o cambie la contraseña).
// Este cambio necesita el secreto de la app, por eso se hace acá del lado del servidor y
// no en el navegador (server/routes/public.js, POST /meta-leads/conectar).
async function obtenerTokenDePaginaDeLargaDuracion({ userAccessToken, pageId }) {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !appSecret) throw new Error('Falta WHATSAPP_APP_ID/WHATSAPP_APP_SECRET en el .env.');

  const exchangeParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: userAccessToken
  });
  const exchangeRes = await fetch(`${GRAPH_BASE}/oauth/access_token?${exchangeParams}`);
  const exchangeData = await exchangeRes.json();
  if (!exchangeRes.ok || !exchangeData.access_token) {
    throw new Error(`Error cambiando el token de usuario por uno de larga duración: ${JSON.stringify(exchangeData)}`);
  }

  const paginasRes = await fetch(`${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(exchangeData.access_token)}`);
  const paginasData = await paginasRes.json();
  if (!paginasRes.ok) throw new Error(`Error consultando las páginas con el token de larga duración: ${JSON.stringify(paginasData)}`);

  const pagina = (paginasData.data || []).find((p) => p.id === pageId);
  if (!pagina) throw new Error('No se encontró esa página entre las páginas del usuario al pedir el token de larga duración (¿se le revocó el acceso después de elegirla?).');
  return pagina.access_token;
}

// Suscribe la página al webhook de "leadgen" de nuestra app - sin esto, aunque la página
// esté conectada, Meta no nos avisa cuando entra un lead nuevo.
async function suscribirPagina({ pageId, pageAccessToken }) {
  const res = await fetch(`${GRAPH_BASE}/${pageId}/subscribed_apps?subscribed_fields=leadgen`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pageAccessToken}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error suscribiendo la página ${pageId} a leadgen: ${JSON.stringify(data)}`);
  return data;
}

// El webhook de "leadgen" solo avisa que hay un lead nuevo (con su ID) - los datos reales
// que completó la persona hay que pedirlos aparte, con el token de la página.
async function obtenerLead({ leadgenId, pageAccessToken }) {
  const res = await fetch(`${GRAPH_BASE}/${leadgenId}?access_token=${pageAccessToken}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`Error consultando el lead ${leadgenId}: ${JSON.stringify(data)}`);
  return data; // { id, created_time, field_data: [{ name, values: [...] }], ad_id, form_id, ... }
}

// Los formularios de Meta tienen preguntas que varía cada campaña (nombre completo, o
// nombre y apellido separados; teléfono o WhatsApp; email; y cualquier pregunta custom que
// el negocio haya armado) - igual criterio de "adivinar por el nombre del campo" que ya
// usamos en la importación de CSV, para no depender de que todas las campañas usen
// exactamente los mismos nombres de pregunta.
const CAMPOS_NOMBRE = ['full_name', 'first_name', 'nombre', 'name'];
const CAMPOS_CONTACTO = ['phone_number', 'whatsapp_number', 'telefono', 'email', 'correo'];

function mapearCamposLead(fieldData = []) {
  const porNombre = {};
  for (const campo of fieldData) {
    porNombre[campo.name] = (campo.values || [])[0] || '';
  }

  let nombre = '';
  for (const clave of CAMPOS_NOMBRE) {
    if (porNombre[clave]) { nombre = porNombre[clave]; break; }
  }
  if (!nombre && porNombre.first_name) {
    nombre = `${porNombre.first_name} ${porNombre.last_name || ''}`.trim();
  }

  let contacto = '';
  for (const clave of CAMPOS_CONTACTO) {
    if (porNombre[clave]) { contacto = porNombre[clave]; break; }
  }

  // El resto de las respuestas (preguntas custom de esa campaña puntual) quedan igual en
  // el mensaje de la ficha, para no perder información aunque no la hayamos podido mapear.
  const resumen = fieldData.map((c) => `${c.name}: ${(c.values || []).join(', ')}`).join('\n');

  return { nombre, contacto, resumen };
}

module.exports = { obtenerTokenDePaginaDeLargaDuracion, suscribirPagina, obtenerLead, mapearCamposLead };
