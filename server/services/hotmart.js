// Pasarela de pago para clientes internacionales (fuera de Argentina): a diferencia de
// Mercado Pago, acá no creamos nada vía API - Hugo arma los productos/ofertas directo en
// el panel de Hotmart (con su propio período de prueba, tarjeta incluida) y nosotros solo
// reaccionamos a los webhooks que manda cuando pasa algo (compra aprobada, cancelación,
// reembolso). Ver server/routes/webhooks.js para el endpoint que usa esto.
//
// Formato del payload confirmado contra un webhook real el 22/10 (sandbox de prueba de
// Hotmart, evento PURCHASE_APPROVED, v2.0.0) - los nombres de campo de acá abajo son los
// reales, no una suposición.

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

// El código de oferta (?off=xxxxx al final de cada link de checkout) es el identificador
// MÁS confiable de qué plan se compró - a diferencia del monto, no depende de en qué
// moneda haya pagado el comprador (Hotmart puede convertir a la moneda local). Arma el
// mapa {codigo: {planId, frecuencia}} leyendo el query param de cada link ya configurado.
function mapaOfertas() {
  const mapa = {};
  const links = linksDeCheckout();
  for (const [planId, frecuencias] of Object.entries(links)) {
    for (const [frecuencia, url] of Object.entries(frecuencias)) {
      if (!url) continue;
      try {
        const codigo = new URL(url).searchParams.get('off');
        if (codigo) mapa[codigo] = { planId, frecuencia };
      } catch {
        // URL mal formada en el .env - se ignora, identificarPlan cae al respaldo por monto
      }
    }
  }
  return mapa;
}

// Hotmart no manda un header de firma HMAC como Meta/Mercado Pago - manda un "Hottok", un
// token fijo por cuenta de Hotmart. Según la versión/integración puede venir en el body,
// como query param, o en el header X-HOTMART-HOTTOK - se chequean los tres por las dudas.
// Comparamos contra el que Hugo carga en el panel de Hotmart y en HOTMART_WEBHOOK_SECRET acá.
function hottokValido(body, query, headers = {}) {
  const secreto = process.env.HOTMART_WEBHOOK_SECRET;
  if (!secreto) return false;
  const recibido = body?.hottok || query?.hottok || headers['x-hotmart-hottok'];
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
    pais: data?.buyer?.address?.country_iso || data?.buyer?.address?.country || '',
    ofertaCodigo: data?.purchase?.offer?.code || null,
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

// Respaldo si no matcheó ningún código de oferta (p.ej. un link viejo que ya no está en el
// .env) - compara el monto cobrado contra los precios de referencia en USD (server/db.js,
// precio_usd_ref/precio_usd_ref_anual), con margen de tolerancia. Solo tiene sentido si
// cobró en USD - si el comprador pagó en su moneda local, esto no va a matchear.
function identificarPlanPorMonto(monto, planes) {
  const TOLERANCIA = 2; // USD
  for (const [id, plan] of Object.entries(planes)) {
    if (!ORDEN_PLANES_HOTMART.includes(id)) continue;
    if (Math.abs(monto - plan.precio_usd_ref) <= TOLERANCIA) return { planId: id, frecuencia: 'mensual' };
    if (Math.abs(monto - plan.precio_usd_ref_anual) <= TOLERANCIA) return { planId: id, frecuencia: 'anual' };
  }
  return null;
}

// Primero intenta por código de oferta (confirmado contra un webhook real que Hotmart lo
// manda en purchase.offer.code - no depende de la moneda en la que haya pagado el
// comprador), y si no matchea nada (p.ej. volvió a usarse un link que ya no está
// configurado), cae al respaldo por monto.
function identificarPlan(datos, planes) {
  if (datos.ofertaCodigo) {
    const porOferta = mapaOfertas()[datos.ofertaCodigo];
    if (porOferta) return porOferta;
  }
  return identificarPlanPorMonto(datos.monto, planes);
}

module.exports = { linksDeCheckout, mapaOfertas, hottokValido, extraerDatosCompra, identificarPlan, identificarPlanPorMonto, inferirIdioma, ORDEN_PLANES_HOTMART };
