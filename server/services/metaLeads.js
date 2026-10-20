// Leads de campañas de Meta Ads (formularios instantáneos de Facebook/Instagram) - en vez
// de que el negocio tenga que bajar el Excel a mano desde el Administrador de Anuncios
// (y Meta solo lo guarda 90 días), cada lead entra solo como ficha al tablero.

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

module.exports = { suscribirPagina, obtenerLead, mapearCamposLead };
