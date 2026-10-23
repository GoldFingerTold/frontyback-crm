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
// Meta entrega los celulares argentinos como 549XXXXXXXXXX, pero la lista de destinatarios
// del número de prueba (y algunas cuentas) los guarda como 54XXXXXXXXXX. Si Meta rechaza el
// envío con "destinatario no autorizado" (131030), reintentamos sin el 9.
async function postMensaje(phoneNumberId, para, payload) {
  const enviar = (destino) =>
    fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, ...payload })
    });

  let res = await enviar(para);
  let data = await res.json();
  if (!res.ok && data?.error?.code === 131030 && /^549\d{10}$/.test(para)) {
    res = await enviar('54' + para.slice(3));
    data = await res.json();
  }
  return { res, data };
}

async function enviarTexto({ phoneNumberId, para, texto }) {
  const { res, data } = await postMensaje(phoneNumberId, para, { type: 'text', text: { body: texto } });
  if (!res.ok) {
    const err = new Error(`Error enviando WhatsApp texto: ${JSON.stringify(data)}`);
    err.codigoMeta = data?.error?.code;
    throw err;
  }
  return data;
}

// Mensaje de plantilla (con costo, cobrado por Meta) - a diferencia de enviarTexto, esto
// funciona aunque hayan pasado más de 24hs desde el último mensaje del cliente, porque no
// depende de la ventana de sesión gratis. Usado para los turnos (confirmación y
// recordatorio), que se mandan de forma proactiva y no como respuesta a algo que el
// cliente escribió. La plantilla tiene que existir y estar aprobada por Meta de antemano.
async function enviarPlantilla({ phoneNumberId, para, nombrePlantilla, idioma = 'es_AR', parametros = [] }) {
  const payload = {
    type: 'template',
    template: {
      name: nombrePlantilla,
      language: { code: idioma },
      components: parametros.length
        ? [{ type: 'body', parameters: parametros.map((texto) => ({ type: 'text', text: String(texto) })) }]
        : []
    }
  };
  const { res, data } = await postMensaje(phoneNumberId, para, payload);
  if (!res.ok) {
    const err = new Error(`Error enviando plantilla de WhatsApp "${nombrePlantilla}": ${JSON.stringify(data)}`);
    err.codigoMeta = data?.error?.code;
    throw err;
  }
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
  const { res, data } = await postMensaje(phoneNumberId, para, { type: 'audio', audio: { id: mediaId } });
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

// Da de alta una plantilla de mensaje en la WABA de un cliente (para que después se pueda
// mandar con enviarPlantilla) - Meta todavía tiene que aprobarla, esto solo la manda a
// revisión. Si ya existe una con ese nombre no es un error real (es justo lo que queremos:
// que exista), así que se devuelve como éxito silencioso.
async function crearPlantilla({ wabaId, nombre, idioma = 'es_AR', textoBody, ejemplos = [] }) {
  const body = {
    name: nombre,
    language: idioma,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: textoBody,
        ...(ejemplos.length ? { example: { body_text: [ejemplos] } } : {})
      }
    ]
  };

  const res = await fetch(`${GRAPH_BASE}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    // El mensaje legible ("ya existe contenido en este idioma para esta plantilla") viene
    // en error_user_title/error_user_msg, no en error.message (que suele ser genérico,
    // "Invalid parameter") - error_subcode 2388024 es el código estable de Meta para este
    // caso puntual, se chequea primero por las dudas de que cambien el texto.
    const textoError = `${data?.error?.message || ''} ${data?.error?.error_user_title || ''} ${data?.error?.error_user_msg || ''}`;
    const yaExiste = data?.error?.error_subcode === 2388024 || /already exists|ya existe/i.test(textoError);
    if (yaExiste) return { yaExistia: true };
    throw new Error(`Error creando la plantilla "${nombre}": ${JSON.stringify(data)}`);
  }
  return data;
}

// Registra el número para la API de mensajería - un paso aparte de la verificación del
// Embedded Signup que Meta exige antes de poder mandar CUALQUIER mensaje (error 133010
// "Account not registered" si se omite). El PIN es de 2 pasos propio de Meta, lo define
// quien registra - no hace falta guardarlo, no se vuelve a pedir para mandar mensajes.
async function registrarNumero({ phoneNumberId, pin }) {
  const res = await fetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messaging_product: 'whatsapp', pin })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error registrando el número ${phoneNumberId}: ${JSON.stringify(data)}`);
  return data;
}

// Código que devuelve Meta cuando se intenta mandar un mensaje de texto libre fuera de la
// ventana de 24hs ("re-engagement message") - server/routes/admin.js lo usa para saber
// cuándo reintentar con PLANTILLA_SEGUIMIENTO en vez de devolver el error tal cual.
const CODIGO_FUERA_DE_VENTANA = 131047;

// Mapea el idioma de FrontyBack (es/en/pt, cliente.idioma - público/i18n/) al código que
// pide Meta para las plantillas. Las plantillas de turnos y seguimiento se registran en
// los 3 (asegurarPlantillas/asegurarPlantillaSeguimiento) y se elige cuál mandar acá según
// el idioma del NEGOCIO (no del cliente final que recibe el mensaje, no tenemos forma de
// saber el de él).
const LOCALES_META = { es: 'es_AR', en: 'en_US', pt: 'pt_BR' };
function localeMeta(idioma) {
  return LOCALES_META[idioma] || LOCALES_META.es;
}

// Plantilla genérica para poder seguir una conversación aunque ya hayan pasado las 24hs
// gratis (a diferencia de las de turnos, que tienen un texto fijo puntual, esta deja
// prácticamente todo el mensaje en una variable, para que el negocio pueda escribir lo
// que necesite). Tiene costo real para el cliente, igual que las de turnos - se usa solo
// como respaldo cuando el mensaje de texto libre no se pudo mandar.
const PLANTILLA_SEGUIMIENTO = 'seguimiento_consulta';

const TEXTOS_SEGUIMIENTO = {
  es_AR: { textoBody: 'Hola {{1}}! Seguimos en contacto por tu consulta: {{2}}. Cualquier cosa, escribinos.', ejemplos: ['Juan', 'Ya tenemos tu pedido listo, podés pasar a retirarlo.'] },
  en_US: { textoBody: "Hi {{1}}! Just following up on your inquiry: {{2}}. Let us know if you need anything else.", ejemplos: ['John', 'Your order is ready, you can come pick it up.'] },
  pt_BR: { textoBody: 'Oi {{1}}! Continuando o contato sobre sua consulta: {{2}}. Qualquer coisa, é só chamar.', ejemplos: ['João', 'Seu pedido já está pronto, pode vir retirar.'] }
};

async function asegurarPlantillaSeguimiento(wabaId) {
  if (!wabaId) return;
  for (const [idioma, { textoBody, ejemplos }] of Object.entries(TEXTOS_SEGUIMIENTO)) {
    try {
      await crearPlantilla({ wabaId, nombre: PLANTILLA_SEGUIMIENTO, idioma, textoBody, ejemplos });
    } catch (err) {
      console.error(`No se pudo crear la plantilla "${PLANTILLA_SEGUIMIENTO}" (${idioma}) en la WABA ${wabaId}:`, err.message);
    }
  }
}

module.exports = {
  enviarTexto,
  enviarPlantilla,
  enviarAudio,
  descargarMedia,
  crearPlantilla,
  registrarNumero,
  asegurarPlantillaSeguimiento,
  PLANTILLA_SEGUIMIENTO,
  CODIGO_FUERA_DE_VENTANA,
  localeMeta
};
