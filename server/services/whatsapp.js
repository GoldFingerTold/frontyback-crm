// Envío y recepción de mensajes vía WhatsApp Business Cloud API (Meta) - API oficial,
// no una librería no oficial. Cada cliente del CRM tiene su propio "phone_number_id"
// (el ID que Meta le asigna a SU número de WhatsApp conectado), así que cada request acá
// recibe ese ID como parámetro en vez de estar hardcodeado.

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function authHeaders() {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error('Falta WHATSAPP_TOKEN en el .env.');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Responde con un mensaje de texto simple. Solo funciona dentro de la ventana de 24hs
// desde el último mensaje del cliente (mensaje de "sesión", gratis) - fuera de esa
// ventana, Meta exige usar una plantilla aprobada (con costo), que no es el caso acá
// porque siempre respondemos a algo que el cliente escribió primero.
async function enviarTexto({ phoneNumberId, para, texto }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: para,
      type: 'text',
      text: { body: texto }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error enviando WhatsApp texto: ${JSON.stringify(data)}`);
  return data;
}

// Sube un archivo de audio (buffer) a los servidores de Meta y devuelve el media_id que
// hace falta para poder enviarlo como mensaje de voz.
async function subirAudio({ phoneNumberId, buffer, mimeType = 'audio/ogg; codecs=opus' }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), 'respuesta.ogg');

  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error subiendo audio a WhatsApp: ${JSON.stringify(data)}`);
  return data.id;
}

// Responde con un mensaje de voz (nota de audio) - lo que se usa para la respuesta con
// voz femenina cuando el cliente mandó un audio.
async function enviarAudio({ phoneNumberId, para, buffer }) {
  const mediaId = await subirAudio({ phoneNumberId, buffer });
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: para,
      type: 'audio',
      audio: { id: mediaId }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error enviando WhatsApp audio: ${JSON.stringify(data)}`);
  return data;
}

// Descarga un audio que mandó el cliente: primero hay que pedirle a Meta la URL real del
// archivo (el media_id que viene en el webhook no es una URL directa), y después bajarlo
// con el mismo token (la URL de Meta exige el header de autorización también).
async function descargarMedia(mediaId) {
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(`Error consultando media de WhatsApp: ${JSON.stringify(meta)}`);

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
  });
  if (!fileRes.ok) throw new Error('Error descargando el archivo de audio de WhatsApp.');
  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type };
}

module.exports = { enviarTexto, enviarAudio, descargarMedia };
