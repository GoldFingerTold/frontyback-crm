// Conexión a MongoDB Atlas. CRM multi-cliente: cada negocio que contrata el servicio es
// un documento en "clientes" (con su propio login y su propio número de WhatsApp
// conectado), y cada consulta que le llega (por formulario o WhatsApp) es una "ficha" en
// la colección "fichas", asociada a ese cliente.

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error(
    'Falta la variable de entorno MONGODB_URI. Copiá .env.example a .env y completala antes de arrancar.'
  );
}

const client = new MongoClient(uri);
let db = null;

function getDb() {
  if (!db) throw new Error('La base de datos todavía no está conectada. Llamá a connect() primero.');
  return db;
}

async function connect() {
  await client.connect();
  db = client.db();
  await ensureIndexes();
  await sembrarPlanes();
  await migrarWhatsappNumeros();
  await migrarUsuarios();
  await migrarTurnosConfigRecordatorios();
  await db.collection('clientes').updateMany(
    { avisos_lead_email: { $exists: false } },
    { $set: { avisos_lead_email: true } }
  );
  console.log('CRM conectado a MongoDB Atlas.');
}

async function ensureIndexes() {
  await db.collection('clientes').createIndex({ slug: 1 }, { unique: true });
  await db.collection('clientes').createIndex({ 'whatsapp_numeros.phone_number_id': 1 });
  await db.collection('clientes').createIndex({ 'meta_pages.page_id': 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, columna_id: 1, posicion: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, contacto: 1 });
  await db.collection('fichas').createIndex({ cliente_id: 1, whatsapp_wa_id: 1 });
  await db.collection('codigos').createIndex({ codigo: 1 }, { unique: true });
  await db.collection('planes').createIndex({ id: 1 }, { unique: true });
  await db.collection('uso_audio_mensual').createIndex({ cliente_id: 1, mes: 1 }, { unique: true });
  await db.collection('usuarios').createIndex({ usuario: 1 }, { unique: true });
  await db.collection('usuarios').createIndex({ cliente_id: 1 });
  await db.collection('push_subscriptions').createIndex({ endpoint: 1 }, { unique: true });
  await db.collection('push_subscriptions').createIndex({ usuario_id: 1 });
  await db.collection('salones').createIndex({ cliente_id: 1 }, { unique: true });
  await db.collection('turnos_config').createIndex({ cliente_id: 1 }, { unique: true });
  await db.collection('turnos').createIndex({ cliente_id: 1, fecha: 1 });
  await db.collection('uso_turnos_mensual').createIndex({ cliente_id: 1, mes: 1 }, { unique: true });
  await db.collection('catalogo_config').createIndex({ cliente_id: 1 }, { unique: true });
  await db.collection('catalogo_items').createIndex({ cliente_id: 1, categoria: 1, posicion: 1 });
  await db.collection('fidelidad_config').createIndex({ cliente_id: 1 }, { unique: true });
  await db.collection('fidelidad_clientes').createIndex({ cliente_id: 1, codigo: 1 }, { unique: true });
}

// Planes públicos que se muestran en la landing de ventas (index.html) y se ofrecen en
// el alta por autoservicio. Viven en Mongo (no hardcodeados) para que Hugo pueda ajustar
// el precio en pesos desde el super-admin cuando se mueva el dólar, sin tocar código.
// precio_usd_ref es solo de referencia para mostrar "≈ USD X" - lo que se cobra de
// verdad (en MercadoPago, y lo que queda guardado en cada cliente) es el *_ars.
// Cada plan tiene precio mensual y un precio anual (pagando el año adelantado, 2 meses
// gratis respecto de pagar mes a mes), y max_whatsapp: cuántas cuentas de WhatsApp puede
// conectar un cliente con ese plan (server/routes/superadmin.js lo hace cumplir al agregar
// un número nuevo).
const PLANES_DEFAULT = [
  {
    id: 'esencial',
    nombre: 'Esencial',
    precio_ars: 15000,
    precio_usd_ref: 10,
    precio_ars_anual: 150000,
    precio_usd_ref_anual: 100,
    max_whatsapp: 1,
    limite_turnos_mensajes_mes: 150,
    descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, turnos online, catálogo con pedidos por WhatsApp, tarjeta de fidelización con QR, página única con todos tus links y tablero de seguimiento.',
    features: ['Formulario y WhatsApp (texto)', 'Respuesta automática al instante', 'Reserva de turnos online, con recordatorio por WhatsApp y por email', 'Catálogo con pedidos directo por WhatsApp', 'Tarjeta de fidelización digital con QR', 'Página única con todos tus links, para tu bio de redes', 'Resumen semanal por email y pedido de reseñas en un click', 'Tablero Kanban', '1 cuenta de WhatsApp conectada']
  },
  {
    id: 'completo',
    nombre: 'Profesional',
    precio_ars: 30000,
    precio_usd_ref: 20,
    precio_ars_anual: 300000,
    precio_usd_ref_anual: 200,
    max_whatsapp: 5,
    limite_turnos_mensajes_mes: 300,
    limite_audios_mes: 300,
    descripcion: 'Todo lo del plan Esencial, más WhatsApp con audio, columnas a medida y hasta 5 cuentas de WhatsApp.',
    features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Hasta 5 cuentas de WhatsApp conectadas']
  },
  {
    id: 'premium',
    nombre: 'Premium',
    precio_ars: 45000,
    precio_usd_ref: 30,
    precio_ars_anual: 450000,
    precio_usd_ref_anual: 300,
    max_whatsapp: 20,
    limite_turnos_mensajes_mes: 450,
    limite_audios_mes: 450,
    descripcion: 'Todo lo del plan Profesional, pensado para negocios con varias sucursales o líneas de WhatsApp.',
    features: ['Todo lo del plan Profesional', 'Hasta 20 cuentas de WhatsApp conectadas', 'Estadísticas y gráficos del embudo de ventas', 'Ideal para varias sucursales o equipos']
  },
  {
    id: 'elite',
    nombre: 'Elite',
    precio_ars: 60000,
    precio_usd_ref: 40,
    precio_ars_anual: 600000,
    precio_usd_ref_anual: 400,
    max_whatsapp: 20,
    limite_turnos_mensajes_mes: 600,
    limite_audios_mes: 600,
    descripcion: 'Todo lo del plan Premium, más el Plano de salón: organizá las mesas, armá el salón a la forma de tu local y marcá el estado en vivo.',
    features: ['Todo lo del plan Premium', 'Plano de salón interactivo (mesas y estado en vivo)', 'Forma del salón editable, a medida de tu local', 'Pensado para gastronomía y organización de eventos']
  }
];

async function sembrarPlanes() {
  const col = db.collection('planes');
  for (const plan of PLANES_DEFAULT) {
    await col.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true });
    // Si el plan ya existía de antes (por ejemplo, antes de agregar los precios anuales o
    // el tope de WhatsApp), completa solo los campos que todavía no tiene - nunca pisa un
    // precio que Hugo ya haya ajustado a mano desde el super-admin.
    await col.updateOne(
      { id: plan.id, precio_ars_anual: { $exists: false } },
      { $set: { precio_ars_anual: plan.precio_ars_anual, precio_usd_ref_anual: plan.precio_usd_ref_anual } }
    );
    await col.updateOne(
      { id: plan.id, max_whatsapp: { $exists: false } },
      { $set: { max_whatsapp: plan.max_whatsapp } }
    );
    await col.updateOne(
      { id: plan.id, limite_turnos_mensajes_mes: { $exists: false } },
      { $set: { limite_turnos_mensajes_mes: plan.limite_turnos_mensajes_mes } }
    );
    if (plan.limite_audios_mes != null) {
      await col.updateOne(
        { id: plan.id, limite_audios_mes: { $exists: false } },
        { $set: { limite_audios_mes: plan.limite_audios_mes } }
      );
    }
  }
  // Sumamos "turnos online" a la descripción/features de Esencial después de que ese plan
  // ya existía en la base - solo si todavía tiene el texto viejo exacto, para no pisar si
  // Hugo ya lo editó a mano por otro motivo.
  await col.updateOne(
    { id: 'esencial', descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, y tablero de seguimiento.' },
    { $set: { descripcion: PLANES_DEFAULT[0].descripcion, features: PLANES_DEFAULT[0].features } }
  );
  // Mismo criterio: sumamos "catálogo con pedidos" después de que Esencial ya tenía el
  // texto de turnos agregado.
  await col.updateOne(
    { id: 'esencial', descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, turnos online y tablero de seguimiento.' },
    { $set: { descripcion: PLANES_DEFAULT[0].descripcion, features: PLANES_DEFAULT[0].features } }
  );
  // Mismo criterio: sumamos "fidelización con QR" después de que Esencial ya tenía el
  // texto de catálogo agregado.
  await col.updateOne(
    { id: 'esencial', descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, turnos online, catálogo con pedidos por WhatsApp y tablero de seguimiento.' },
    { $set: { descripcion: PLANES_DEFAULT[0].descripcion, features: PLANES_DEFAULT[0].features } }
  );
  // Mismo criterio: sumamos "página única" + "resumen semanal" después de que Esencial ya
  // tenía el texto de fidelización agregado.
  await col.updateOne(
    { id: 'esencial', descripcion: 'Formulario + WhatsApp (texto) con respuesta automática, turnos online, catálogo con pedidos por WhatsApp, tarjeta de fidelización con QR y tablero de seguimiento.' },
    { $set: { descripcion: PLANES_DEFAULT[0].descripcion, features: PLANES_DEFAULT[0].features } }
  );
  // El plan "completo" pasó a llamarse "Profesional" (ahora que el diferencial principal
  // frente a Esencial es la cantidad de cuentas de WhatsApp, no solo el audio) - una sola
  // vez, no pisa el nombre si Hugo ya lo cambió a otra cosa.
  await col.updateOne(
    { id: 'completo', nombre: 'Completo' },
    {
      $set: {
        nombre: 'Profesional',
        descripcion: 'Todo lo del plan Esencial, más WhatsApp con audio, columnas a medida y hasta 5 cuentas de WhatsApp.',
        features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Consultas ilimitadas', 'Hasta 5 cuentas de WhatsApp conectadas']
      }
    }
  );
  // "Consultas ilimitadas" sonaba a que no había ningún control de costo (y no era cierto:
  // siempre estuvo pensado proporcional al plan, como el tope de turnos) - lo cambiamos por
  // el número real en Profesional, y lo agregamos a Premium/Elite que todavía no lo tenían.
  await col.updateOne(
    { id: 'completo', features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Consultas ilimitadas', 'Hasta 5 cuentas de WhatsApp conectadas'] },
    { $set: { features: PLANES_DEFAULT[1].features } }
  );
  await col.updateOne(
    { id: 'premium', features: ['Todo lo del plan Profesional', 'Hasta 20 cuentas de WhatsApp conectadas', 'Estadísticas y gráficos del embudo de ventas', 'Ideal para varias sucursales o equipos'] },
    { $set: { features: PLANES_DEFAULT[2].features } }
  );
  await col.updateOne(
    { id: 'elite', features: ['Todo lo del plan Premium', 'Plano de salón interactivo (mesas y estado en vivo)', 'Forma del salón editable, a medida de tu local', 'Pensado para gastronomía y organización de eventos'] },
    { $set: { features: PLANES_DEFAULT[3].features } }
  );
  // Sacamos "Hasta N consultas por mes" de los 4 planes - nunca hubo un tope técnico real
  // detrás (las consultas de texto no tienen costo, son mensajes de sesión gratis), así que
  // ese número no representaba nada y podía sonar a limitación falsa. En su lugar, Esencial
  // ahora aclara que el recordatorio de turno se puede mandar por WhatsApp y por email.
  await col.updateOne(
    { id: 'esencial', features: ['Formulario y WhatsApp (texto)', 'Respuesta automática al instante', 'Reserva de turnos online, con recordatorio por WhatsApp', 'Catálogo con pedidos directo por WhatsApp', 'Tarjeta de fidelización digital con QR', 'Página única con todos tus links, para tu bio de redes', 'Resumen semanal por email y pedido de reseñas en un click', 'Tablero Kanban', 'Hasta 150 consultas por mes', '1 cuenta de WhatsApp conectada'] },
    { $set: { features: PLANES_DEFAULT[0].features } }
  );
  await col.updateOne(
    { id: 'completo', features: ['Todo lo del plan Esencial', 'WhatsApp con audio (transcripción y respuesta con voz)', 'Columnas del tablero personalizables', 'Hasta 300 consultas por mes', 'Hasta 5 cuentas de WhatsApp conectadas'] },
    { $set: { features: PLANES_DEFAULT[1].features } }
  );
  await col.updateOne(
    { id: 'premium', features: ['Todo lo del plan Profesional', 'Hasta 20 cuentas de WhatsApp conectadas', 'Hasta 450 consultas por mes', 'Estadísticas y gráficos del embudo de ventas', 'Ideal para varias sucursales o equipos'] },
    { $set: { features: PLANES_DEFAULT[2].features } }
  );
  await col.updateOne(
    { id: 'elite', features: ['Todo lo del plan Premium', 'Hasta 600 consultas por mes', 'Plano de salón interactivo (mesas y estado en vivo)', 'Forma del salón editable, a medida de tu local', 'Pensado para gastronomía y organización de eventos'] },
    { $set: { features: PLANES_DEFAULT[3].features } }
  );
}

async function getPlanes() {
  const lista = await db.collection('planes').find({}).sort({ precio_ars: 1 }).toArray();
  const mapa = {};
  for (const p of lista) mapa[p.id] = p;
  return mapa;
}

// Cada plan limita cuántas cuentas de WhatsApp puede tener conectadas un cliente a la vez -
// sin plan asignado, se asume el tope más chico (1) para no dejar conectar de más por error
// antes de que Hugo le asigne un plan de verdad.
async function maxWhatsappDeCliente(cliente) {
  if (!cliente.plan) return 1;
  const planes = await getPlanes();
  return planes[cliente.plan]?.max_whatsapp ?? 1;
}

// Agrega un número de WhatsApp a un cliente, respetando el tope de su plan - usado tanto
// por la carga manual del super-admin como por el Embedded Signup (cuando el cliente se
// conecta solo). Tira error si ya está conectado o si no hay lugar.
async function agregarWhatsappNumero(clienteId, { phone_number_id, waba_id = null, etiqueta = '' }) {
  const mongo = getDb();
  const id = normalizarClienteId(clienteId);
  const cliente = await mongo.collection('clientes').findOne({ _id: id });
  if (!cliente) throw new Error('No existe ese cliente.');
  if (!phone_number_id) throw new Error('Falta el Phone Number ID.');

  const numeros = cliente.whatsapp_numeros || [];
  if (numeros.some((n) => n.phone_number_id === phone_number_id)) {
    throw new Error('Ese número ya está conectado a este cliente.');
  }
  const max = await maxWhatsappDeCliente(cliente);
  if (numeros.length >= max) {
    throw new Error(`Este cliente ya tiene el máximo de ${max} cuenta${max === 1 ? '' : 's'} de WhatsApp de su plan.`);
  }

  await mongo.collection('clientes').updateOne(
    { _id: id },
    {
      $push: {
        whatsapp_numeros: {
          phone_number_id,
          waba_id: waba_id || null,
          etiqueta: String(etiqueta || '').trim().slice(0, 40)
        }
      }
    }
  );
}

// Páginas de Facebook/Instagram conectadas para recibir leads de campañas de Meta Ads
// (formularios instantáneos) - a diferencia de WhatsApp, no hay tope por plan, cualquier
// cliente puede conectar las páginas que quiera.
async function agregarMetaPage(clienteId, { page_id, page_name, page_access_token }) {
  const mongo = getDb();
  const id = normalizarClienteId(clienteId);
  const cliente = await mongo.collection('clientes').findOne({ _id: id });
  if (!cliente) throw new Error('No existe ese cliente.');
  if (!page_id || !page_access_token) throw new Error('Faltan datos de la página.');

  const paginas = cliente.meta_pages || [];
  if (paginas.some((p) => p.page_id === page_id)) {
    // Ya estaba conectada - actualizamos el token (puede haber cambiado) en vez de
    // duplicarla o tirar error, para que reconectar sea siempre seguro de reintentar.
    await mongo.collection('clientes').updateOne(
      { _id: id, 'meta_pages.page_id': page_id },
      { $set: { 'meta_pages.$.page_access_token': page_access_token, 'meta_pages.$.page_name': page_name || '' } }
    );
    return;
  }

  await mongo.collection('clientes').updateOne(
    { _id: id },
    { $push: { meta_pages: { page_id, page_name: page_name || '', page_access_token, conectado_en: new Date() } } }
  );
}

const DIAS_PRUEBA_GRATIS = 7;
const DIAS_GRACIA = 7;

// Qué puede hacer cada estado de pago cuando llega una consulta nueva (formulario o
// WhatsApp):
// - prueba / activo: se guarda la ficha y se manda la respuesta automática, todo normal.
// - vencido_gracia: se guarda la ficha (no se pierde el lead del cliente final), pero NO
//   se manda respuesta automática - esa es la parte "paga" que se corta primero.
// - vencido_cortado / cancelado: no se guarda nada, el servicio está completamente
//   detenido hasta que vuelva a pagar.
function estadoPermiteCaptura(estadoPago) {
  return estadoPago !== 'vencido_cortado' && estadoPago !== 'cancelado';
}
function estadoPermiteRespuesta(estadoPago) {
  return estadoPago === 'prueba' || estadoPago === 'activo';
}

// Lo llama el webhook de Mercado Pago cuando se autoriza una suscripción o se cobra una
// cuota: el cliente queda activo y se borran los plazos de prueba/gracia (si los tenía).
async function activarPorPago(clienteId, { preapprovalId } = {}) {
  const set = { estado_pago: 'activo', prueba_termina: null, gracia_termina: null };
  if (preapprovalId) set.mercadopago_preapproval_id = preapprovalId;
  await getDb().collection('clientes').updateOne({ _id: clienteId }, { $set: set });
}

// Lo llama el webhook de Mercado Pago cuando Mercado Pago cancela la suscripción porque no
// pudo cobrarle al cliente (tarjeta rechazada varias veces) - entra al mismo período de
// gracia de 7 días que el vencimiento de la prueba gratis.
async function cortarPorFaltaDePago(clienteId) {
  const gracia_termina = new Date(Date.now() + DIAS_GRACIA * 24 * 60 * 60 * 1000);
  await getDb().collection('clientes').updateOne(
    { _id: clienteId, estado_pago: { $ne: 'vencido_cortado' } },
    { $set: { estado_pago: 'vencido_gracia', gracia_termina } }
  );
}

// Columnas por defecto del tablero de un cliente nuevo - se pueden editar después desde
// el panel (agregar, renombrar o borrar columnas), esto es solo el punto de partida.
const COLUMNAS_DEFAULT = [
  { id: 'nuevo', nombre: 'Nuevos', posicion: 0 },
  { id: 'contactado', nombre: 'Contactados', posicion: 1 },
  { id: 'negociacion', nombre: 'En negociación', posicion: 2 },
  { id: 'ganado', nombre: 'Venta concretada', posicion: 3 },
  { id: 'perdido', nombre: 'No avanzó', posicion: 4 }
];

// Una cuenta dada de alta con un código 100% gratis no deja ninguna facturación que
// compense lo que cuesta transcribir y responder con voz por WhatsApp (son las dos únicas
// funciones de este CRM con costo variable por uso - todo lo demás es gratis o de costo
// fijo). Por eso a esas cuentas se les pone un tope mensual de audios por defecto, editable
// por cliente desde el super-admin si hace falta más.
const LIMITE_AUDIOS_CODIGO_GRATIS = 30;

// origen: 'superadmin' (alta manual, sin período de prueba, se asume ya acordado con
// Hugo) | 'landing' (autoservicio vía Mercado Pago, arranca en prueba gratis sin tarjeta,
// FrontyBack maneja el plazo de 7 días) | 'hotmart' (autoservicio internacional: Hotmart ya
// aprobó el pago/arrancó su propio período de prueba con tarjeta de su lado, así que acá
// arranca "activo" de una - no hay un segundo período de prueba corriendo en paralelo).
// El login ya no vive en el cliente - se crea acá mismo el primer usuario, con rol
// "gerencia" (ve todas las fichas, sin importar el departamento) y usuario = el slug,
// para no cambiarle nada al formulario de alta ni a la pantalla de login existentes.
async function crearCliente({
  slug,
  nombre,
  email_notificacion,
  admin_password,
  plan = null,
  precio_pactado = 0,
  frecuencia_pago = 'mensual',
  origen = 'superadmin',
  codigo_referido = null,
  descuento_pct_aplicado = 0,
  comision_pct_aplicada = 0,
  pasarela_pago = 'mercado_pago',
  hotmart_data = null,
  idioma = 'es',
  consentimiento = null
}) {
  const ahora = new Date();
  const esAltaAutoservicio = origen === 'landing';

  const doc = {
    slug,
    nombre,
    email_notificacion: email_notificacion || '',
    whatsapp_numeros: [],
    columnas: COLUMNAS_DEFAULT,
    plan,
    precio_pactado,
    frecuencia_pago,
    origen,
    codigo_referido,
    descuento_pct_aplicado,
    comision_pct_aplicada,
    limite_audios_mes: descuento_pct_aplicado >= 100 ? LIMITE_AUDIOS_CODIGO_GRATIS : null,
    avisos_lead_email: true,
    // Qué pasarela cobra la suscripción de este cliente - default 'mercado_pago' para no
    // dejar sin valor a ningún cliente existente (todos los de antes de esto son de MP).
    pasarela_pago,
    hotmart_data,
    // Idioma de la landing al momento del alta (español/inglés/portugués por ahora) - el
    // dashboard interno y las respuestas de WhatsApp todavía son solo en español, esto por
    // ahora solo queda guardado para cuando se traduzcan también.
    idioma,
    // Aceptación de Términos/Privacidad al darse de alta por la landing - null para
    // orígenes que no pasan por ese formulario (Hotmart, alta manual del superadmin), que
    // tienen su propia instancia de consentimiento (Hotmart, al pagar).
    consentimiento,
    estado_pago: esAltaAutoservicio ? 'prueba' : 'activo',
    prueba_termina: esAltaAutoservicio
      ? new Date(ahora.getTime() + DIAS_PRUEBA_GRATIS * 24 * 60 * 60 * 1000)
      : null,
    created_at: ahora
  };
  const { insertedId } = await getDb().collection('clientes').insertOne(doc);

  await getDb().collection('usuarios').insertOne({
    cliente_id: insertedId,
    usuario: slug,
    password_hash: bcrypt.hashSync(admin_password, 10),
    nombre: 'Gerencia',
    rol: 'gerencia',
    departamento: null,
    created_at: ahora
  });

  return { _id: insertedId, ...doc };
}

// Cuenta cuántos audios de WhatsApp ya se transcribieron este mes para un cliente -
// contador aparte de "fichas" porque una misma persona que manda varios audios no genera
// una ficha nueva por cada uno (se deduplican por contacto), así que contar fichas
// subestimaría el uso real.
function mesActual() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

async function contarUsoAudioEsteMes(clienteId) {
  const doc = await getDb().collection('uso_audio_mensual').findOne({ cliente_id: clienteId, mes: mesActual() });
  return doc?.cantidad || 0;
}

async function registrarUsoAudio(clienteId) {
  await getDb().collection('uso_audio_mensual').updateOne(
    { cliente_id: clienteId, mes: mesActual() },
    { $inc: { cantidad: 1 } },
    { upsert: true }
  );
}

// A diferencia del tope de turnos (que ahora es solo informativo, porque lo termina
// pagando la tarjeta del cliente en Meta), el audio SÍ sale directo del bolsillo de
// FrontyBack (OpenAI + ElevenLabs, con nuestra propia API key) - así que acá el tope
// sigue siendo un corte real. cliente.limite_audios_mes sigue existiendo como
// override manual (lo usan las cuentas con código de descuento 100%, o un cliente
// puntual al que Hugo le quiera dar otro número) - si no está seteado, se usa el
// tope del plan en vez de "sin límite".
async function maxAudiosMesDeCliente(cliente) {
  if (cliente.limite_audios_mes != null) return cliente.limite_audios_mes;
  if (!cliente.plan) return 0;
  const planes = await getPlanes();
  return planes[cliente.plan]?.limite_audios_mes ?? null;
}

// Antes cada cliente tenía un solo whatsapp_phone_number_id - ahora puede tener varios,
// en whatsapp_numeros. Convierte una sola vez los clientes viejos que todavía no tienen
// ese array, sin perder el número que ya tenían conectado.
async function migrarWhatsappNumeros() {
  const col = db.collection('clientes');
  const viejos = await col.find({ whatsapp_numeros: { $exists: false } }).toArray();
  for (const c of viejos) {
    const numeros = c.whatsapp_phone_number_id
      ? [{ phone_number_id: c.whatsapp_phone_number_id, etiqueta: '' }]
      : [];
    await col.updateOne(
      { _id: c._id },
      { $set: { whatsapp_numeros: numeros }, $unset: { whatsapp_phone_number_id: '', whatsapp_display_phone: '' } }
    );
  }
}

// Los clientes creados antes de que existiera este sistema de usuarios tenían el login
// directo en admin_password_hash - se convierte una sola vez al mismo usuario "Gerencia"
// que ahora crea crearCliente(), sin tocar la contraseña (se copia el hash tal cual, así
// nadie pierde el acceso con la contraseña que ya tenía).
async function migrarUsuarios() {
  const clientes = db.collection('clientes');
  const usuarios = db.collection('usuarios');
  const viejos = await clientes.find({ admin_password_hash: { $exists: true } }).toArray();
  for (const c of viejos) {
    await usuarios.updateOne(
      { usuario: c.slug },
      {
        $setOnInsert: {
          cliente_id: c._id,
          usuario: c.slug,
          password_hash: c.admin_password_hash,
          nombre: 'Gerencia',
          rol: 'gerencia',
          departamento: null,
          created_at: c.created_at || new Date()
        }
      },
      { upsert: true }
    );
    await clientes.updateOne({ _id: c._id }, { $unset: { admin_password_hash: '' } });
  }
}

// Departamentos disponibles para un cliente: las etiquetas que Hugo ya les puso a sus
// cuentas de WhatsApp conectadas (sin repetidos, sin las vacías) - así Gerencia solo puede
// asignarle a un empleado un departamento que de verdad tiene una línea de WhatsApp detrás.
function departamentosDeCliente(cliente) {
  const etiquetas = (cliente.whatsapp_numeros || []).map((n) => n.etiqueta).filter(Boolean);
  return [...new Set(etiquetas)];
}

// ---------- Plano de salón (exclusivo del plan Elite) ----------
// Un documento por cliente, en su propia colección (no mezclado con "clientes" ni con
// "fichas") a propósito: la forma del salón (un polígono, no un rectángulo fijo, para que
// cada local pueda tener la forma real que tiene) y la lista de mesas que tiene adentro.
// Separarlo así hace que el día de mañana, si esto se vende como producto aparte en un
// subdominio propio, la colección se pueda migrar sola sin tocar el resto del CRM.
const FORMA_SALON_DEFAULT = [
  { x: 60, y: 60 }, { x: 740, y: 60 }, { x: 740, y: 500 }, { x: 60, y: 500 }
];

function normalizarClienteId(clienteId) {
  return typeof clienteId === 'string' ? new ObjectId(clienteId) : clienteId;
}

async function getSalon(clienteId) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  let salon = await col.findOne({ cliente_id: id });
  if (!salon) {
    const doc = { cliente_id: id, forma: FORMA_SALON_DEFAULT, mesas: [], puntos: [], updated_at: new Date() };
    const { insertedId } = await col.insertOne(doc);
    salon = { ...doc, _id: insertedId };
  }
  if (!salon.puntos) salon.puntos = []; // salones creados antes de que existieran los marcadores
  return salon;
}

async function guardarFormaSalon(clienteId, forma) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await getSalon(id);
  await col.updateOne({ cliente_id: id }, { $set: { forma, updated_at: new Date() } });
  return getSalon(id);
}

async function agregarMesa(clienteId, mesa) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await getSalon(id);
  const nueva = {
    id: crypto.randomUUID(),
    nombre: mesa.nombre || 'Mesa',
    x: Number(mesa.x) || 100,
    y: Number(mesa.y) || 100,
    ancho: Number(mesa.ancho) || 80,
    alto: Number(mesa.alto) || 80,
    tipo: mesa.tipo === 'circulo' ? 'circulo' : 'rect',
    capacidad: Number(mesa.capacidad) || 4,
    estado: 'libre',
    nota: ''
  };
  await col.updateOne({ cliente_id: id }, { $push: { mesas: nueva }, $set: { updated_at: new Date() } });
  return getSalon(id);
}

// "cambios" lo arma la ruta (admin.js / salon.js) con solo los campos que quiere tocar -
// nunca se le pasa el body entero, para no poder pisar un campo de la mesa que no
// corresponde.
async function actualizarMesa(clienteId, mesaId, cambios) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(cambios)) set[`mesas.$.${k}`] = v;
  await col.updateOne({ cliente_id: id, 'mesas.id': mesaId }, { $set: set });
  return getSalon(id);
}

async function eliminarMesa(clienteId, mesaId) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await col.updateOne({ cliente_id: id }, { $pull: { mesas: { id: mesaId } }, $set: { updated_at: new Date() } });
  return getSalon(id);
}

// Marcadores de referencia (entrada, salida, cocina, baño): solo una posición en el plano,
// sin plano propio ni estado - Gerencia los pone una vez y casi no los vuelve a tocar.
async function agregarPunto(clienteId, punto) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await getSalon(id);
  const nuevo = {
    id: crypto.randomUUID(),
    tipo: punto.tipo,
    nombre: (punto.nombre || '').slice(0, 40),
    x: Number(punto.x) || 100,
    y: Number(punto.y) || 100
  };
  await col.updateOne({ cliente_id: id }, { $push: { puntos: nuevo }, $set: { updated_at: new Date() } });
  return getSalon(id);
}

async function actualizarPunto(clienteId, puntoId, cambios) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  const set = { updated_at: new Date() };
  for (const [k, v] of Object.entries(cambios)) set[`puntos.$.${k}`] = v;
  await col.updateOne({ cliente_id: id, 'puntos.id': puntoId }, { $set: set });
  return getSalon(id);
}

async function eliminarPunto(clienteId, puntoId) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await col.updateOne({ cliente_id: id }, { $pull: { puntos: { id: puntoId } }, $set: { updated_at: new Date() } });
  return getSalon(id);
}

// Vuelve el salón al rectángulo por defecto, sin mesas - para que Gerencia pueda empezar
// de cero sin tener que pedirlo por fuera del CRM.
async function reiniciarSalon(clienteId) {
  const col = db.collection('salones');
  const id = normalizarClienteId(clienteId);
  await col.deleteOne({ cliente_id: id });
  return getSalon(id);
}

// ---------- Turnos / reservas (incluido desde el plan Esencial) ----------
// Un documento de configuración por cliente (servicios + disponibilidad semanal) y una
// colección de turnos reservados. Por defecto el horario es uno solo para todo el negocio
// (no por servicio ni por empleado) - así de simple: el negocio solo puede atender una cosa
// a la vez, así que todos los servicios compiten por el mismo horario. Si el negocio
// agrega "profesionales" (peluquería/salón con varios empleados, cada uno con su propia
// agenda), ese modo pasa a requerir elegir profesional al reservar, y cada uno tiene su
// propio horario semanal en vez de compartir el del negocio - ver horariosDisponibles y
// crearTurno más abajo.
const DIA_NOMBRE = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const DISPONIBILIDAD_DEFAULT = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
  dia,
  activo: dia >= 1 && dia <= 5,
  desde: '09:00',
  hasta: '18:00'
}));

// Argentina es UTC-3 todo el año (sin horario de verano) - calculamos "ahora" con ese
// desplazamiento fijo en vez de confiar en la zona horaria configurada en el VPS (que
// puede estar en UTC), así los días/horarios de los turnos siempre quedan en hora de
// Buenos Aires sin importar dónde corra el servidor.
const ARG_OFFSET_MS = -3 * 60 * 60 * 1000;
function ahoraArgentina() {
  return new Date(Date.now() + ARG_OFFSET_MS);
}

function horaAMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}
function minutosAHora(min) {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

// Compartida entre horariosDisponibles, crearTurno y reprogramarTurnoPorToken - un
// bloque choca con otro si se superponen en el tiempo (no alcanza con que no sean el
// mismo hora_inicio exacto).
function existeChoqueHorario(turnosOcupados, inicioMin, finMin) {
  return turnosOcupados.some((t) => {
    const tInicio = horaAMinutos(t.hora_inicio);
    const tFin = horaAMinutos(t.hora_fin);
    return inicioMin < tFin && finMin > tInicio;
  });
}

// Qué cuenta como "ocupado" para los choques de horario: un turno confirmado, SIEMPRE; o
// uno todavía esperando que paguen la seña pero sin vencer - mientras esos 15 minutos no
// pasen, el horario queda reservado para que no lo agarre otra persona mientras la primera
// está pagando. Si vence sin pagar, deja de contar (ciclo-turnos.js lo cancela después).
function filtroEstadoOcupado(ahora) {
  return { $or: [{ estado: 'confirmado' }, { estado: 'pendiente_pago', pago_vence: { $gt: ahora } }] };
}

async function getTurnosConfig(clienteId) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  let config = await col.findOne({ cliente_id: id });
  if (!config) {
    // Default para cuentas nuevas: email prendido (no tiene costo), WhatsApp apagado (el
    // cliente tiene que elegir pagarlo a sabiendas) - Hugo prefiere bajar el precio de la
    // suscripción antes que arriesgarse a un costo de Meta que no eligió.
    const doc = {
      cliente_id: id,
      servicios: [],
      disponibilidad: DISPONIBILIDAD_DEFAULT,
      profesionales: [],
      recordatorio_whatsapp: false,
      recordatorio_email: true,
      // Seña para confirmar un turno: apagada por defecto, igual que el recordatorio por
      // WhatsApp - es una decisión del negocio (y además requiere conectar su propia cuenta
      // de Mercado Pago), no algo que se le prenda sin que lo pida. "sena" sin ñ a propósito
      // (identificador JS, no texto) - el resto del código usa siempre este nombre.
      sena_activa: false,
      sena_monto: 0,
      updated_at: new Date()
    };
    const { insertedId } = await col.insertOne(doc);
    config = { ...doc, _id: insertedId };
  }
  return config;
}

async function guardarRecordatorios(clienteId, { whatsapp, email }) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  await getTurnosConfig(id);
  await col.updateOne(
    { cliente_id: id },
    { $set: { recordatorio_whatsapp: Boolean(whatsapp), recordatorio_email: Boolean(email), updated_at: new Date() } }
  );
  return getTurnosConfig(id);
}

async function guardarSena(clienteId, { activa, monto }) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  await getTurnosConfig(id);
  await col.updateOne(
    { cliente_id: id },
    { $set: { sena_activa: Boolean(activa), sena_monto: Math.max(0, Math.round(Number(monto) || 0)), updated_at: new Date() } }
  );
  return getTurnosConfig(id);
}

// Las cuentas que ya tenían Turnos configurado antes de que existieran estos dos switches
// seguían recibiendo el recordatorio por WhatsApp siempre (era el único canal) - se
// preserva ese comportamiento para no cortarles algo que ya venían usando. El de email
// arranca apagado para ellas porque antes no existía la posibilidad de cargarlo.
async function migrarTurnosConfigRecordatorios() {
  const col = db.collection('turnos_config');
  await col.updateMany(
    { recordatorio_whatsapp: { $exists: false } },
    { $set: { recordatorio_whatsapp: true } }
  );
  await col.updateMany(
    { recordatorio_email: { $exists: false } },
    { $set: { recordatorio_email: false } }
  );
}

async function guardarServicios(clienteId, servicios) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  await getTurnosConfig(id);
  await col.updateOne({ cliente_id: id }, { $set: { servicios, updated_at: new Date() } });
  return getTurnosConfig(id);
}

async function guardarDisponibilidad(clienteId, disponibilidad) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  await getTurnosConfig(id);
  await col.updateOne({ cliente_id: id }, { $set: { disponibilidad, updated_at: new Date() } });
  return getTurnosConfig(id);
}

// Profesionales (ej. peluqueras de un salón): cada uno con su propio horario semanal, en
// vez de uno solo compartido para todo el negocio. Apenas hay uno o más, horariosDisponibles
// y crearTurno pasan a exigir elegir profesional (ver ahí) - la validación de la forma de
// "disponibilidad" la hace la ruta (server/routes/turnos.js), acá solo se persiste.
async function guardarProfesionales(clienteId, profesionales) {
  const col = db.collection('turnos_config');
  const id = normalizarClienteId(clienteId);
  await getTurnosConfig(id);
  await col.updateOne({ cliente_id: id }, { $set: { profesionales, updated_at: new Date() } });
  return getTurnosConfig(id);
}

// Arma los horarios libres de los próximos N días para un servicio: genera todos los
// bloques posibles según la disponibilidad semanal, y descarta los que se pisan con un
// turno ya confirmado. Si el negocio tiene profesionales configurados, profesionalId es
// obligatorio: la disponibilidad y los choques de horario pasan a ser los de ESE
// profesional (dos profesionales sí pueden tener un turno a la misma hora) en vez de los
// del negocio entero.
async function horariosDisponibles(clienteId, { servicioId, profesionalId, dias = 14 }) {
  const id = normalizarClienteId(clienteId);
  const config = await getTurnosConfig(id);
  const servicio = config.servicios.find((s) => s.id === servicioId);
  if (!servicio) throw new Error('Ese servicio no existe.');

  const profesionales = config.profesionales || [];
  let disponibilidadSemanal = config.disponibilidad;
  if (profesionales.length) {
    const profesional = profesionales.find((p) => p.id === profesionalId);
    if (!profesional) throw new Error('Ese profesional no existe.');
    disponibilidadSemanal = profesional.disponibilidad;
  }

  const ahora = ahoraArgentina();
  const desdeStr = ahora.toISOString().slice(0, 10);
  const hastaStr = new Date(ahora.getTime() + dias * 86400000).toISOString().slice(0, 10);

  const turnosExistentes = await getDb().collection('turnos').find({
    cliente_id: id,
    ...filtroEstadoOcupado(ahora),
    ...(profesionales.length ? { profesional_id: profesionalId } : {}),
    fecha: { $gte: desdeStr, $lte: hastaStr }
  }).toArray();

  const porFecha = {};
  for (const t of turnosExistentes) {
    (porFecha[t.fecha] ||= []).push(t);
  }

  const ahoraMin = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const resultado = [];
  for (let i = 0; i < dias; i++) {
    const fecha = new Date(ahora.getTime() + i * 86400000);
    const fechaStr = fecha.toISOString().slice(0, 10);
    const diaSemana = fecha.getUTCDay();
    const disp = disponibilidadSemanal.find((d) => d.dia === diaSemana);
    if (!disp || !disp.activo) continue;

    const inicioDia = horaAMinutos(disp.desde);
    const finDia = horaAMinutos(disp.hasta);
    const ocupados = porFecha[fechaStr] || [];

    const horarios = [];
    for (let inicio = inicioDia; inicio + servicio.duracion_min <= finDia; inicio += servicio.duracion_min) {
      const fin = inicio + servicio.duracion_min;
      if (i === 0 && inicio <= ahoraMin + 30) continue; // hoy: no ofrecer horarios que ya pasaron (30 min de margen)
      if (!existeChoqueHorario(ocupados, inicio, fin)) horarios.push({ hora_inicio: minutosAHora(inicio), hora_fin: minutosAHora(fin) });
    }
    if (horarios.length) resultado.push({ fecha: fechaStr, dia_nombre: DIA_NOMBRE[diaSemana], horarios });
  }
  return resultado;
}

// Vuelve a chequear el choque de horarios al confirmar (no solo al mostrar los horarios
// libres), para la carrera de dos personas reservando el mismo horario casi al mismo
// tiempo - no es a prueba de balas (no hay lock), pero para el volumen de un negocio
// chico esto alcanza de sobra. Con profesionales configurados, el choque se chequea solo
// contra los turnos del MISMO profesional (otro profesional puede tener un turno a la
// misma hora sin problema).
async function crearTurno(clienteId, datos) {
  const id = normalizarClienteId(clienteId);
  const config = await getTurnosConfig(id);
  const servicio = config.servicios.find((s) => s.id === datos.servicio_id);
  if (!servicio) throw new Error('Ese servicio no existe.');

  const profesionales = config.profesionales || [];
  let profesional = null;
  if (profesionales.length) {
    profesional = profesionales.find((p) => p.id === datos.profesional_id);
    if (!profesional) throw new Error('Ese profesional no existe.');
  }

  const inicio = horaAMinutos(datos.hora_inicio);
  const fin = inicio + servicio.duracion_min;
  const ahora = new Date();

  const existentes = await getDb().collection('turnos').find({
    cliente_id: id,
    fecha: datos.fecha,
    ...filtroEstadoOcupado(ahora),
    ...(profesional ? { profesional_id: profesional.id } : {})
  }).toArray();
  if (existeChoqueHorario(existentes, inicio, fin)) throw new Error('Ese horario ya no está disponible, elegí otro.');

  // Si el negocio pide seña para confirmar, el turno nace "pendiente_pago" (ocupa el
  // horario igual, ver filtroEstadoOcupado) hasta que el webhook de Mercado Pago confirme
  // que se pagó - recién ahí pasa a "confirmado" y se avisa por WhatsApp/email
  // (server/routes/webhooks.js, procesarNotificacionMercadoPagoTurno). Si no paga dentro
  // de los 15 minutos, ciclo-turnos.js lo cancela para liberar el horario.
  const requierePago = Boolean(config.sena_activa) && config.sena_monto > 0;

  const doc = {
    cliente_id: id,
    servicio_id: servicio.id,
    servicio_nombre: servicio.nombre,
    profesional_id: profesional?.id || null,
    profesional_nombre: profesional?.nombre || null,
    fecha: datos.fecha,
    hora_inicio: datos.hora_inicio,
    hora_fin: minutosAHora(fin),
    nombre_contacto: String(datos.nombre_contacto || '').trim().slice(0, 120),
    telefono_contacto: String(datos.telefono_contacto || '').trim().slice(0, 30),
    email_contacto: String(datos.email_contacto || '').trim().slice(0, 150),
    estado: requierePago ? 'pendiente_pago' : 'confirmado',
    ...(requierePago ? { pago_vence: new Date(ahora.getTime() + 15 * 60 * 1000), sena_monto: config.sena_monto } : {}),
    recordatorio_enviado: false,
    // Token para que el cliente final pueda cancelar/reprogramar su turno sin loguearse ni
    // escribirle al negocio (public/mi-turno.html) - va en el link del email de confirmación
    // y recordatorio, y se muestra en la pantalla de éxito al reservar.
    token_gestion: crypto.randomBytes(20).toString('hex'),
    created_at: new Date()
  };
  const { insertedId } = await getDb().collection('turnos').insertOne(doc);
  return { _id: insertedId, ...doc };
}

// Devuelve true solo la primera vez que se confirma este turno (el filtro
// estado:'pendiente_pago' hace que reintentos del webhook de Mercado Pago sean no-ops) -
// quien llama usa esto para no volver a avisar por WhatsApp/email un turno ya confirmado.
async function confirmarTurnoPagado(turnoId) {
  const resultado = await getDb().collection('turnos').updateOne(
    { _id: turnoId, estado: 'pendiente_pago' },
    { $set: { estado: 'confirmado' }, $unset: { pago_vence: '' } }
  );
  return resultado.modifiedCount > 0;
}

// Corre en ciclo-turnos.js junto con los recordatorios - libera los horarios de quien
// empezó a reservar pero nunca llegó a pagar la seña.
async function cancelarTurnosPagoVencido() {
  const resultado = await getDb().collection('turnos').updateMany(
    { estado: 'pendiente_pago', pago_vence: { $lt: new Date() } },
    { $set: { estado: 'cancelado' } }
  );
  return resultado.modifiedCount;
}

async function cancelarTurno(clienteId, turnoId) {
  const id = normalizarClienteId(clienteId);
  await getDb().collection('turnos').updateOne(
    { _id: new ObjectId(turnoId), cliente_id: id },
    { $set: { estado: 'cancelado' } }
  );
}

// ---------- Gestión del turno por el cliente final (sin login, por token) ----------
async function obtenerTurnoPorToken(token) {
  if (!token) return null;
  const turno = await getDb().collection('turnos').findOne({ token_gestion: token });
  if (!turno) return null;
  const cliente = await getDb().collection('clientes').findOne({ _id: turno.cliente_id });
  return { turno, nombreNegocio: cliente?.nombre || '', slugNegocio: cliente?.slug || '' };
}

async function cancelarTurnoPorToken(token) {
  const encontrado = await obtenerTurnoPorToken(token);
  if (!encontrado) throw new Error('No encontramos ese turno.');
  if (encontrado.turno.estado === 'cancelado') throw new Error('Ese turno ya estaba cancelado.');
  await getDb().collection('turnos').updateOne({ _id: encontrado.turno._id }, { $set: { estado: 'cancelado' } });
  return encontrado.turno;
}

// Reusa horariosDisponibles (el mismo cálculo que ve el cliente al reservar) para
// revalidar que el horario pedido sigue libre antes de mover el turno - evita duplicar la
// lógica de choques/disponibilidad semanal en un tercer lugar.
async function reprogramarTurnoPorToken(token, { fecha, hora_inicio }) {
  const encontrado = await obtenerTurnoPorToken(token);
  if (!encontrado) throw new Error('No encontramos ese turno.');
  const { turno } = encontrado;
  if (turno.estado === 'cancelado') throw new Error('Este turno ya está cancelado, no se puede reprogramar.');

  const dias = await horariosDisponibles(turno.cliente_id, {
    servicioId: turno.servicio_id,
    profesionalId: turno.profesional_id || undefined,
    dias: 30
  });
  const diaElegido = dias.find((d) => d.fecha === fecha);
  const horarioElegido = diaElegido?.horarios.find((h) => h.hora_inicio === hora_inicio);
  if (!horarioElegido) throw new Error('Ese horario ya no está disponible, elegí otro.');

  await getDb().collection('turnos').updateOne(
    { _id: turno._id },
    { $set: { fecha, hora_inicio: horarioElegido.hora_inicio, hora_fin: horarioElegido.hora_fin, recordatorio_enviado: false } }
  );
  return { ...turno, fecha, hora_inicio: horarioElegido.hora_inicio, hora_fin: horarioElegido.hora_fin };
}

async function listarTurnos(clienteId, { desde, hasta } = {}) {
  const id = normalizarClienteId(clienteId);
  const filtro = { cliente_id: id };
  if (desde || hasta) {
    filtro.fecha = {};
    if (desde) filtro.fecha.$gte = desde;
    if (hasta) filtro.fecha.$lte = hasta;
  }
  return getDb().collection('turnos').find(filtro).sort({ fecha: 1, hora_inicio: 1 }).toArray();
}

// Cada plan tiene un tope mensual de mensajes de WhatsApp de turnos (confirmación +
// recordatorio juntos) para no exponernos a lo que cobra Meta por plantilla fuera de la
// ventana de 24hs - calculado con la tarifa más cara posible, para no perder plata nunca.
async function maxTurnosMensajesDeCliente(cliente) {
  if (!cliente.plan) return 0;
  const planes = await getPlanes();
  return planes[cliente.plan]?.limite_turnos_mensajes_mes ?? 0;
}

async function contarUsoTurnosEsteMes(clienteId) {
  const doc = await getDb().collection('uso_turnos_mensual').findOne({ cliente_id: clienteId, mes: mesActual() });
  return doc?.cantidad || 0;
}

async function registrarUsoTurno(clienteId) {
  await getDb().collection('uso_turnos_mensual').updateOne(
    { cliente_id: clienteId, mes: mesActual() },
    { $inc: { cantidad: 1 } },
    { upsert: true }
  );
}

// La WABA de cada cliente factura contra SU propio método de pago (cargado por ellos en
// Meta Business Manager, no el nuestro) - superado lo incluido en el plan, Meta le cobra
// directo a su tarjeta. Si todavía no la cargaron, Meta devuelve el error 131042 al mandar
// una plantilla; acá queda marcado para avisarle en el panel, y se limpia solo en cuanto
// un envío vuelve a salir bien.
async function marcarWhatsappPagoPendiente(clienteId, pendiente) {
  await getDb().collection('clientes').updateOne(
    { _id: clienteId },
    { $set: { whatsapp_pago_pendiente: pendiente } }
  );
}

// ---------- Catálogo + pedidos por WhatsApp (incluido desde el plan Esencial) ----------
// Pensado para que no haga falta tener WhatsApp Business conectado vía Meta: el pedido se
// arma como un link de WhatsApp normal (wa.me) con el mensaje prellenado, lo manda el
// cliente final desde su propio WhatsApp - cero costo, cero plantillas, cero API de Meta.
// El teléfono de pedidos es independiente del WhatsApp conectado al CRM, por si el
// negocio quiere que los pedidos lleguen a otro número/persona.
async function getCatalogoConfig(clienteId) {
  const col = db.collection('catalogo_config');
  const id = normalizarClienteId(clienteId);
  let config = await col.findOne({ cliente_id: id });
  if (!config) {
    const doc = { cliente_id: id, telefono_pedidos: '', updated_at: new Date() };
    const { insertedId } = await col.insertOne(doc);
    config = { ...doc, _id: insertedId };
  }
  return config;
}

async function guardarTelefonoPedidos(clienteId, telefono) {
  const col = db.collection('catalogo_config');
  const id = normalizarClienteId(clienteId);
  await getCatalogoConfig(id);
  await col.updateOne({ cliente_id: id }, { $set: { telefono_pedidos: telefono, updated_at: new Date() } });
  return getCatalogoConfig(id);
}

async function listarCatalogo(clienteId, { soloDisponibles = false } = {}) {
  const id = normalizarClienteId(clienteId);
  const filtro = { cliente_id: id };
  if (soloDisponibles) filtro.disponible = true;
  return getDb().collection('catalogo_items').find(filtro).sort({ categoria: 1, posicion: 1 }).toArray();
}

async function siguientePosicionCatalogo(clienteId, categoria) {
  const ultimo = await getDb().collection('catalogo_items')
    .find({ cliente_id: clienteId, categoria })
    .sort({ posicion: -1 })
    .limit(1)
    .toArray();
  return ultimo.length > 0 ? ultimo[0].posicion + 1 : 0;
}

async function agregarItemCatalogo(clienteId, item) {
  const id = normalizarClienteId(clienteId);
  const categoria = String(item.categoria || '').trim().slice(0, 40) || 'General';
  const doc = {
    cliente_id: id,
    nombre: String(item.nombre || '').trim().slice(0, 100),
    descripcion: String(item.descripcion || '').trim().slice(0, 300),
    precio: Math.max(Number(item.precio) || 0, 0),
    categoria,
    disponible: item.disponible !== false,
    posicion: await siguientePosicionCatalogo(id, categoria),
    created_at: new Date()
  };
  if (!doc.nombre) throw new Error('Falta el nombre del producto.');
  const { insertedId } = await getDb().collection('catalogo_items').insertOne(doc);
  return { _id: insertedId, ...doc };
}

async function actualizarItemCatalogo(clienteId, itemId, cambios) {
  const id = normalizarClienteId(clienteId);
  const set = {};
  if (cambios.nombre !== undefined) set.nombre = String(cambios.nombre).trim().slice(0, 100);
  if (cambios.descripcion !== undefined) set.descripcion = String(cambios.descripcion).trim().slice(0, 300);
  if (cambios.precio !== undefined) set.precio = Math.max(Number(cambios.precio) || 0, 0);
  if (cambios.categoria !== undefined) set.categoria = String(cambios.categoria).trim().slice(0, 40) || 'General';
  if (cambios.disponible !== undefined) set.disponible = !!cambios.disponible;
  await getDb().collection('catalogo_items').updateOne({ _id: new ObjectId(itemId), cliente_id: id }, { $set: set });
}

async function eliminarItemCatalogo(clienteId, itemId) {
  const id = normalizarClienteId(clienteId);
  await getDb().collection('catalogo_items').deleteOne({ _id: new ObjectId(itemId), cliente_id: id });
}

// ---------- Tarjeta de fidelización digital con QR (incluido desde el plan Esencial) ----------
// El negocio escanea el QR del cliente al cobrarle (no al revés), para que cada punto
// corresponda a una compra real. El QR en sí solo contiene el "codigo" único del cliente -
// no hace falta ninguna API de WhatsApp Business ni de Meta para nada de esto.
//
// Dos modos de sumar puntos (a elección del negocio):
// - "visita": cada escaneo suma 1 punto fijo, sin pedir nada más (rápido para el mostrador).
// - "monto": el empleado carga cuánto gastó el cliente, y los puntos salen de dividir ese
//   monto por "monto_por_punto" (ej. $1000 por punto).
// Puede haber varios premios a distintos niveles de puntos a la vez (no uno solo) - al
// canjear uno, se le restan sus puntos al cliente (no se resetea todo a cero), para que lo
// que le sobró le siga sumando para el próximo premio.
function generarCodigoFidelidad() {
  return crypto.randomBytes(5).toString('base64url').toUpperCase().slice(0, 7);
}

function generarIdPremio() {
  return crypto.randomBytes(4).toString('hex');
}

function limpiarPremios(premios) {
  const limpio = (Array.isArray(premios) ? premios : [])
    .map((p) => ({
      id: p.id || generarIdPremio(),
      puntos_necesarios: Math.min(Math.max(parseInt(p.puntos_necesarios, 10) || 1, 1), 1000),
      descripcion: String(p.descripcion || '').trim().slice(0, 120)
    }))
    .filter((p) => p.descripcion);
  limpio.sort((a, b) => a.puntos_necesarios - b.puntos_necesarios);
  return limpio;
}

async function getFidelidadConfig(clienteId) {
  const col = db.collection('fidelidad_config');
  const id = normalizarClienteId(clienteId);
  let config = await col.findOne({ cliente_id: id });
  if (!config) {
    const doc = {
      cliente_id: id,
      modo: 'visita',
      monto_por_punto: 1000,
      premios: [{ id: generarIdPremio(), puntos_necesarios: 10, descripcion: 'Un producto gratis' }],
      updated_at: new Date()
    };
    const { insertedId } = await col.insertOne(doc);
    config = { ...doc, _id: insertedId };
  }
  return config;
}

async function guardarFidelidadConfig(clienteId, { modo, monto_por_punto, premios }) {
  const col = db.collection('fidelidad_config');
  const id = normalizarClienteId(clienteId);
  await getFidelidadConfig(id);
  const premiosLimpios = limpiarPremios(premios);
  if (premiosLimpios.length === 0) throw new Error('Cargá al menos un premio.');

  await col.updateOne(
    { cliente_id: id },
    {
      $set: {
        modo: modo === 'monto' ? 'monto' : 'visita',
        monto_por_punto: Math.max(Number(monto_por_punto) || 1000, 1),
        premios: premiosLimpios,
        updated_at: new Date()
      }
    }
  );
  return getFidelidadConfig(id);
}

async function registrarClienteFidelidad(clienteId, { nombre, telefono }) {
  const id = normalizarClienteId(clienteId);
  const nombreLimpio = String(nombre || '').trim().slice(0, 120);
  const telefonoLimpio = String(telefono || '').trim().slice(0, 30);
  if (!nombreLimpio) throw new Error('Falta el nombre.');

  let codigo;
  let col = getDb().collection('fidelidad_clientes');
  do {
    codigo = generarCodigoFidelidad();
  } while (await col.findOne({ cliente_id: id, codigo }));

  const doc = {
    cliente_id: id,
    codigo,
    nombre: nombreLimpio,
    telefono: telefonoLimpio,
    puntos: 0,
    premios_canjeados: 0,
    created_at: new Date(),
    updated_at: new Date()
  };
  const { insertedId } = await col.insertOne(doc);
  return { _id: insertedId, ...doc };
}

async function getTarjetaFidelidad(clienteId, codigo) {
  const id = normalizarClienteId(clienteId);
  const tarjeta = await getDb().collection('fidelidad_clientes').findOne({ cliente_id: id, codigo });
  if (!tarjeta) throw new Error('No encontramos esa tarjeta.');
  return tarjeta;
}

async function sellarTarjeta(clienteId, codigo, { monto } = {}) {
  const id = normalizarClienteId(clienteId);
  const config = await getFidelidadConfig(id);
  const tarjeta = await getTarjetaFidelidad(id, codigo);

  let puntosASumar = 1;
  if (config.modo === 'monto') {
    const montoNum = Number(monto) || 0;
    if (montoNum <= 0) throw new Error('Cargá cuánto gastó el cliente.');
    puntosASumar = Math.floor(montoNum / config.monto_por_punto);
    if (puntosASumar < 1) throw new Error(`Hacen falta al menos $${config.monto_por_punto} para sumar un punto.`);
  }

  await getDb().collection('fidelidad_clientes').updateOne(
    { _id: tarjeta._id },
    { $inc: { puntos: puntosASumar }, $set: { updated_at: new Date() } }
  );
  return getTarjetaFidelidad(id, codigo);
}

async function canjearPremioFidelidad(clienteId, codigo, premioId) {
  const id = normalizarClienteId(clienteId);
  const config = await getFidelidadConfig(id);
  const tarjeta = await getTarjetaFidelidad(id, codigo);
  const premio = config.premios.find((p) => p.id === premioId);
  if (!premio) throw new Error('Ese premio no existe.');
  if (tarjeta.puntos < premio.puntos_necesarios) {
    throw new Error('Esta tarjeta todavía no llegó a ese premio.');
  }
  await getDb().collection('fidelidad_clientes').updateOne(
    { _id: tarjeta._id },
    { $inc: { puntos: -premio.puntos_necesarios, premios_canjeados: 1 }, $set: { updated_at: new Date() } }
  );
  return getTarjetaFidelidad(id, codigo);
}

async function listarClientesFidelidad(clienteId) {
  const id = normalizarClienteId(clienteId);
  return getDb().collection('fidelidad_clientes').find({ cliente_id: id }).sort({ updated_at: -1 }).toArray();
}

module.exports = {
  connect,
  getDb,
  ObjectId,
  crearCliente,
  COLUMNAS_DEFAULT,
  getPlanes,
  DIAS_PRUEBA_GRATIS,
  DIAS_GRACIA,
  estadoPermiteCaptura,
  estadoPermiteRespuesta,
  activarPorPago,
  cortarPorFaltaDePago,
  contarUsoAudioEsteMes,
  registrarUsoAudio,
  departamentosDeCliente,
  getSalon,
  guardarFormaSalon,
  agregarMesa,
  actualizarMesa,
  eliminarMesa,
  reiniciarSalon,
  agregarPunto,
  actualizarPunto,
  eliminarPunto,
  maxWhatsappDeCliente,
  agregarWhatsappNumero,
  agregarMetaPage,
  getTurnosConfig,
  guardarServicios,
  guardarDisponibilidad,
  guardarProfesionales,
  guardarRecordatorios,
  guardarSena,
  confirmarTurnoPagado,
  cancelarTurnosPagoVencido,
  horariosDisponibles,
  crearTurno,
  cancelarTurno,
  listarTurnos,
  obtenerTurnoPorToken,
  cancelarTurnoPorToken,
  reprogramarTurnoPorToken,
  maxTurnosMensajesDeCliente,
  contarUsoTurnosEsteMes,
  registrarUsoTurno,
  marcarWhatsappPagoPendiente,
  maxAudiosMesDeCliente,
  getCatalogoConfig,
  guardarTelefonoPedidos,
  listarCatalogo,
  agregarItemCatalogo,
  actualizarItemCatalogo,
  eliminarItemCatalogo,
  getFidelidadConfig,
  guardarFidelidadConfig,
  registrarClienteFidelidad,
  getTarjetaFidelidad,
  sellarTarjeta,
  canjearPremioFidelidad,
  listarClientesFidelidad
};
