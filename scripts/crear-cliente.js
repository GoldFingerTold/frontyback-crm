// Da de alta un cliente nuevo del CRM. Uso:
//   node scripts/crear-cliente.js "<slug>" "<nombre del negocio>" "<email>" "<contraseña>"
//
// Ejemplo:
//   node scripts/crear-cliente.js goodshow "Good Show Casino" contacto@goodshowcasino.com.ar unaClaveSegura123

require('dotenv').config();
const db = require('../server/db');

async function main() {
  const [slug, nombre, email, password] = process.argv.slice(2);
  if (!slug || !nombre || !password) {
    console.error('Uso: node scripts/crear-cliente.js "<slug>" "<nombre>" "<email>" "<contraseña>"');
    process.exit(1);
  }

  await db.connect();
  const cliente = await db.crearCliente({ slug, nombre, email_notificacion: email, admin_password: password });

  console.log('Cliente creado:');
  console.log('  slug:', cliente.slug);
  console.log('  nombre:', cliente.nombre);
  console.log('  id:', cliente._id.toString());
  console.log('');
  console.log('Pendiente: conectar su número de WhatsApp (whatsapp_phone_number_id) y avisarle el link');
  console.log('del formulario de su sitio para que apunte a POST /webhook/form/' + slug);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
