// Resumen semanal por email: todos los lunes, un mail con lo que pasó la semana anterior
// en el CRM (leads nuevos, turnos reservados, clientes de fidelidad nuevos) - no hace
// falta ninguna pantalla nueva, solo lee datos que ya se guardan solos. Va por email (no
// WhatsApp) para no depender de que el cliente tenga un número de WhatsApp conectado ni de
// una plantilla aprobada por Meta - funciona para el 100% de los clientes, desde el primer
// día.

const db = require('../db');
const email = require('./email');

// Año + número de semana ISO, para no mandar el mismo resumen 2 veces la misma semana
// aunque el servidor se reinicie varias veces un mismo lunes.
function semanaActual() {
  const ahora = new Date();
  const d = new Date(Date.UTC(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const inicioAno = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil((((d - inicioAno) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}

async function mandarResumenes() {
  const ahora = new Date();
  if (ahora.getDay() !== 1) return; // Solo los lunes

  const mongo = db.getDb();
  const semana = semanaActual();
  const desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

  const clientes = await mongo.collection('clientes').find({
    resumen_semanal_email: { $ne: false },
    email_notificacion: { $nin: [null, ''] },
    ultimo_resumen_semana: { $ne: semana }
  }).toArray();

  let enviados = 0;
  for (const cliente of clientes) {
    try {
      const [fichasNuevas, turnosNuevos, fidelidadNuevos] = await Promise.all([
        mongo.collection('fichas').countDocuments({ cliente_id: cliente._id, fecha_hora_recibido: { $gte: desde } }),
        mongo.collection('turnos').countDocuments({ cliente_id: cliente._id, created_at: { $gte: desde } }),
        mongo.collection('fidelidad_clientes').countDocuments({ cliente_id: cliente._id, created_at: { $gte: desde } })
      ]);

      // Si no pasó nada en toda la semana, no vale la pena mandar un mail vacío.
      if (fichasNuevas === 0 && turnosNuevos === 0 && fidelidadNuevos === 0) {
        await mongo.collection('clientes').updateOne({ _id: cliente._id }, { $set: { ultimo_resumen_semana: semana } });
        continue;
      }

      await email.enviarResumenSemanal({
        emailDestinatario: cliente.email_notificacion,
        nombreCliente: cliente.nombre,
        fichasNuevas,
        turnosNuevos,
        fidelidadNuevos
      });
      await mongo.collection('clientes').updateOne({ _id: cliente._id }, { $set: { ultimo_resumen_semana: semana } });
      enviados++;
    } catch (err) {
      console.error(`No se pudo mandar el resumen semanal a ${cliente.slug}:`, err.message);
    }
  }
  if (enviados) console.log(`Resumen semanal: ${enviados} email(s) enviados.`);
}

function iniciar() {
  const chequear = () => mandarResumenes().catch((err) => console.error('Error mandando resúmenes semanales:', err));
  chequear();
  setInterval(chequear, 60 * 60 * 1000); // chequea cada hora, pero solo manda los lunes
}

module.exports = { iniciar, mandarResumenes };
