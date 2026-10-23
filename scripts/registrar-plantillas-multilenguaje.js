// Las plantillas de turnos (confirmación/recordatorio) y la de seguimiento ahora se
// registran en 3 idiomas (es_AR/en_US/pt_BR) en vez de solo español - pero eso solo pasa
// automáticamente para una WABA que se conecta DE ACÁ EN ADELANTE (server/routes/
// public.js, POST /whatsapp/conectar). Los clientes que ya estaban conectados antes de
// este cambio se quedaron solo con las plantillas en español - este script las completa:
// recorre todos los clientes con WhatsApp conectado y vuelve a llamar
// asegurarPlantillas/asegurarPlantillaSeguimiento para cada WABA distinta que encuentra.
//
// Seguro de correr más de una vez: whatsapp.crearPlantilla no falla si la plantilla ya
// existe (la mayoría de los es_AR ya van a estar creados), solo agrega lo que falta.
//
// Uso: node scripts/registrar-plantillas-multilenguaje.js

require('dotenv').config();
const db = require('../server/db');
const turnosWhatsapp = require('../server/services/turnos');
const whatsapp = require('../server/services/whatsapp');

async function main() {
  await db.connect();
  const mongo = db.getDb();

  const clientes = await mongo
    .collection('clientes')
    .find({ whatsapp_numeros: { $exists: true, $not: { $size: 0 } } })
    .toArray();

  const wabaIds = new Set();
  for (const cliente of clientes) {
    for (const numero of cliente.whatsapp_numeros || []) {
      if (numero.waba_id) wabaIds.add(numero.waba_id);
    }
  }

  console.log(`Clientes con WhatsApp conectado: ${clientes.length}. WABA distintas con waba_id guardado: ${wabaIds.size}.`);
  const sinWaba = clientes.filter((c) => (c.whatsapp_numeros || []).every((n) => !n.waba_id));
  if (sinWaba.length) {
    console.log(`Ojo: ${sinWaba.length} cliente(s) tienen número conectado pero sin waba_id guardado (conexión vieja) - no se les puede registrar nada automáticamente: ${sinWaba.map((c) => c.slug).join(', ')}`);
  }

  let ok = 0;
  for (const wabaId of wabaIds) {
    console.log(`\n--- WABA ${wabaId} ---`);
    try {
      await turnosWhatsapp.asegurarPlantillas(wabaId);
      await whatsapp.asegurarPlantillaSeguimiento(wabaId);
      ok++;
    } catch (err) {
      console.error(`Error inesperado en la WABA ${wabaId}:`, err.message);
    }
  }

  console.log(`\nListo: se procesaron ${ok}/${wabaIds.size} WABA. Revisá los logs de arriba por si alguna plantilla puntual falló (quedan registradas igual, Meta las tiene que aprobar - puede tardar).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\n', err);
  process.exit(1);
});
