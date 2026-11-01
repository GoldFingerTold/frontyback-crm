// Lee la casilla de consulta (IMAP) y convierte cada email recibido en una ficha del tablero
// del negocio IMAP_SLUG (por defecto "crm-frontyback", el negocio Fronty), así lo que
// llega a consulta@frontyback.com se ve y se responde desde el CRM junto al resto de los leads.
//
// - No marca nada como leído ni mueve mails: guarda el último UID procesado en Mongo. La primera
//   vez NO importa el historial, solo lo que llegue desde ese momento.
// - Ignora respuestas automáticas, rebotes, newsletters y lo que manda la propia casilla.
// - Sin IMAP_USER / IMAP_PASS en el .env, no hace nada.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../db');

const CADA_MS = 2 * 60 * 1000;
const MAX_POR_VUELTA = 30;
const IGNORAR_REMITENTE = /mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?@/i;

let corriendo = false;
let avisoSinConfig = false;

function config() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) return null;
  return {
    host: process.env.IMAP_HOST || 'imap.hostinger.com',
    port: Number(process.env.IMAP_PORT) || 993,
    user,
    pass,
    slug: process.env.IMAP_SLUG || 'crm-frontyback'
  };
}

function esAutomatico(parsed, remitente, propia) {
  if (!remitente || remitente === propia) return true;
  if (IGNORAR_REMITENTE.test(remitente)) return true;
  const auto = String(parsed.headers.get('auto-submitted') || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  const precedencia = String(parsed.headers.get('precedence') || '').toLowerCase();
  if (/bulk|list|junk/.test(precedencia)) return true;
  if ((parsed.headerLines || []).some((h) => h.key === 'list-unsubscribe')) return true;
  return false;
}

async function procesarMensaje(cliente, parsed, cfg) {
  const de = parsed.from?.value?.[0];
  const remitente = String(de?.address || '').toLowerCase();
  if (esAutomatico(parsed, remitente, cfg.user.toLowerCase())) return false;

  const asunto = String(parsed.subject || '(sin asunto)').slice(0, 200);
  const cuerpo = String(parsed.text || '').replace(/\r/g, '').trim().slice(0, 1800);
  const mensaje = `Email: ${asunto}${cuerpo ? '\n\n' + cuerpo : ''}`;
  const nombre = String(de?.name || '').slice(0, 120);

  const fichas = require('./fichas');
  const ficha = await fichas.registrarConsulta({
    clienteId: cliente._id,
    columnaInicial: cliente.columnas[0].id,
    contacto: remitente,
    nombre,
    origen: 'formulario',
    mensaje
  });
  // Lazy: webhooks.js ya importa muchos servicios, evitamos el require circular al cargar
  const webhooks = require('../routes/webhooks');
  await webhooks.avisarLeadNuevo(cliente, ficha, { nombreContacto: nombre, contacto: remitente, origen: 'formulario', mensaje });
  return true;
}

async function revisar() {
  const cfg = config();
  if (!cfg) {
    if (!avisoSinConfig) { console.log('Correo entrante: sin IMAP_USER/IMAP_PASS, desactivado.'); avisoSinConfig = true; }
    return;
  }
  const mongo = db.getDb();
  const cliente = await mongo.collection('clientes').findOne({ slug: cfg.slug });
  if (!cliente || !db.estadoPermiteCaptura(cliente.estado_pago) || !cliente.columnas?.length) return;

  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  client.on('error', () => {});
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const estados = mongo.collection('correo_entrante');
    const estado = await estados.findOne({ _id: cfg.user });
    const validez = Number(client.mailbox.uidValidity);
    const ultimaDelBuzon = client.mailbox.uidNext - 1;

    if (!estado || estado.uid_validity !== validez) {
      await estados.updateOne({ _id: cfg.user }, { $set: { uid_validity: validez, ultimo_uid: ultimaDelBuzon, desde: new Date() } }, { upsert: true });
      console.log(`Correo entrante: empieza a leer ${cfg.user} desde el UID ${ultimaDelBuzon + 1}.`);
      return;
    }
    if (ultimaDelBuzon <= estado.ultimo_uid) return;

    let ultimo = estado.ultimo_uid;
    let vistos = 0;
    for await (const msg of client.fetch(`${estado.ultimo_uid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= estado.ultimo_uid) continue;
      if (vistos++ >= MAX_POR_VUELTA) break;
      try {
        const parsed = await simpleParser(msg.source);
        await procesarMensaje(cliente, parsed, cfg);
      } catch (err) {
        console.error(`Correo entrante: no se pudo procesar el UID ${msg.uid}:`, err.message);
      }
      ultimo = msg.uid;
    }
    if (ultimo !== estado.ultimo_uid) {
      await estados.updateOne({ _id: cfg.user }, { $set: { ultimo_uid: ultimo } });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function vuelta() {
  if (corriendo) return;
  corriendo = true;
  try { await revisar(); } catch (err) { console.error('Correo entrante:', err.message); } finally { corriendo = false; }
}

function iniciar() {
  setTimeout(vuelta, 30 * 1000);
  setInterval(vuelta, CADA_MS);
}

module.exports = { iniciar, revisar };
