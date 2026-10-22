// Pasarela de pago para clientes internacionales (fuera de Argentina): a diferencia de
// Mercado Pago, acá no creamos nada vía API - Hugo arma los productos/ofertas directo en
// el panel de Hotmart (con su propio período de prueba, tarjeta incluida) y nosotros solo
// reaccionamos a los webhooks que manda cuando pasa algo (compra aprobada, cancelación,
// reembolso). Ver server/routes/webhooks.js para el endpoint que usa esto.
//
// OJO: el formato exacto del payload de Hotmart (nombres de campos, cómo manda el Hottok)
// está armado acá con el formato más común documentado por Hotmart y por integraciones de
// terceros (v2.0.0), pero NO está confirmado contra un webhook real todavía - en cuanto
// Hugo tenga el producto creado en Hotmart, hay que mandar un webhook de prueba desde su
// panel y revisar los logs del servidor (quedan logueados completos si no matchea nada)
// para ajustar los nombres de campo si hace falta.

// Los 4 planes de FrontyBack, en el mismo orden que ya usan los precios de referencia en
// USD (server/db.js, precio_usd_ref) - plan 1 es el más barato (Esencial), plan 4 el más
// caro (Elite). Mismo orden que las variables HOTMART_PLAN1.._4 del .env.
const ORDEN_PLANES_HOTMART = ['esencial', 'completo', 'premium', 'elite'];

function linksDeCheckout() {
  const links = {};
  ORDEN_PLANES_HOTMART.forEach((planId, i) => {
    const n = i + 1;
    links[planId] = {
      mensual: process.env[`HOTMART_PLAN${n}_MENSUAL`] || null,
      anual: process.env[`HOTMART_PLAN${n}_ANUAL`] || null
    };
  });
  return links;
}

// Hotmart no manda un header de firma HMAC como Meta/Mercado Pago - manda un "Hottok", un
// token fijo por cuenta de Hotmart, en el body de cada notificación (algunas integraciones
// también lo aceptan como query param). Comparamos contra el que Hugo carga en el panel de
// Hotmart y en HOTMART_WEBHOOK_SECRET acá.
function hottokValido(body, query) {
  const secreto = process.env.HOTMART_WEBHOOK_SECRET;
  if (!secreto) return false;
  const recibido = body?.hottok || query?.hottok;
  return Boolean(recibido) && recibido === secreto;
}

// Saca del payload lo que necesitamos, sea cual sea el nombre exacto de los campos - si
// Hotmart manda el formato "v2" documentado públicamente, esto debería funcionar tal cual;
// si no, igual no explota, solo devuelve campos vacíos (el que llama loguea el payload
// crudo para poder ajustar esto rápido).
function extraerDatosCompra(body) {
  const data = body?.data || body || {};
  return {
    evento: String(body?.event || data?.event || '').toUpperCase(),
    email: data?.buyer?.email || data?.buyer?.checkout_phone || '',
    nombre: data?.buyer?.name || '',
    pais: data?.buyer?.address?.country || data?.buyer?.document_type || '',
    monto: Number(data?.purchase?.price?.value ?? data?.purchase?.original_offer_price?.value ?? NaN),
    moneda: data?.purchase?.price?.currency_value || data?.currency || '',
    transaccion: data?.purchase?.transaction || null,
    subscriberCode: data?.subscription?.subscriber?.code || null,
    estadoCompra: String(data?.purchase?.status || data?.status || '').toUpperCase()
  };
}

// Idioma para guardar en el cliente nuevo (landing en 3 idiomas - ver public/i18n/) - lo
// más confiable que tenemos del payload de Hotmart es la MONEDA del cobro, no el país (ese
// campo varía más entre integraciones). BRL es casi siempre Brasil -> portugués; el resto
// de Latinoamérica compra mayormente en USD igual que el resto del mundo, así que no hay
// forma confiable de distinguir "español" de "inglés" solo con esto - default a inglés,
// que es lo esperable para alguien que llega por un checkout de Hotmart en vez del
// formulario en español de la landing.
function inferirIdioma({ moneda }) {
  if (String(moneda || '').toUpperCase() === 'BRL') return 'pt';
  return 'en';
}

// Encuentra qué plan y frecuencia compró, comparando el monto cobrado contra los precios
// de referencia en USD (server/db.js, precio_usd_ref/precio_usd_ref_anual) - con un margen
// chico de tolerancia porque Hotmart puede convertir a la moneda local del comprador y
// redondear distinto. Si el comprador pagó en una moneda que no sea USD, esto puede no
// matchear - revisar el log si pasa.
function identificarPlanPorMonto(monto, planes) {
  const TOLERANCIA = 2; // USD
  for (const [id, plan] of Object.entries(planes)) {
    if (!ORDEN_PLANES_HOTMART.includes(id)) continue;
    if (Math.abs(monto - plan.precio_usd_ref) <= TOLERANCIA) return { planId: id, frecuencia: 'mensual' };
    if (Math.abs(monto - plan.precio_usd_ref_anual) <= TOLERANCIA) return { planId: id, frecuencia: 'anual' };
  }
  return null;
}

module.exports = { linksDeCheckout, hottokValido, extraerDatosCompra, identificarPlanPorMonto, inferirIdioma, ORDEN_PLANES_HOTMART };
