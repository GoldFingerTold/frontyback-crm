// Aviso real (no solo el ícono visual del tablero) cuando una ficha lleva varios días sin
// novedades - antes había que acordarse de mirar el tablero para notarlo, ahora le llega
// un email al dueño del negocio solo. Mismo criterio de "fría" que ya usa el tablero
// (public/js/tablero.js, fichaEstaFria): más de DIAS_FRIO días sin mensaje nuevo, y
// todavía en una etapa activa (ni vendida ni descartada).

const db = require('../db');
const email = require('./email');

const DIAS_FRIO = 5;
const MS_FRIO = DIAS_FRIO * 24 * 60 * 60 * 1000;

function esColumnaGanada(nombre) {
  return /concretad|ganad|vend/i.test(nombre || '');
}
function esColumnaPerdida(nombre) {
  return /perdid|no avanz|descart|cancel/i.test(nombre || '');
}

async function avisarFichasFrias() {
  const mongo = db.getDb();
  const limite = new Date(Date.now() - MS_FRIO);

  const clientes = await mongo.collection('clientes').find({
    avisos_lead_email: { $ne: false },
    email_notificacion: { $nin: [null, ''] }
  }).toArray();

  let avisados = 0;
  for (const cliente of clientes) {
    try {
      const columnasActivas = (cliente.columnas || [])
        .filter((c) => !esColumnaGanada(c.nombre) && !esColumnaPerdida(c.nombre))
        .map((c) => c.id);
      if (!columnasActivas.length) continue;

      // "aviso_fria_enviado: true" evita avisar de nuevo la misma ficha todos los días
      // mientras siga fría - se resetea solo cuando vuelve a tener actividad real
      // (fichas.js registrarConsulta) o cuando alguien la mueve de etapa (admin.js).
      const fichasFrias = await mongo.collection('fichas').find({
        cliente_id: cliente._id,
        columna_id: { $in: columnasActivas },
        fecha_hora_ultimo_mensaje: { $lt: limite },
        aviso_fria_enviado: { $ne: true }
      }).toArray();

      if (!fichasFrias.length) continue;

      await email.enviarAvisoFichasFrias({
        emailDestinatario: cliente.email_notificacion,
        nombreCliente: cliente.nombre,
        fichas: fichasFrias.map((f) => ({
          nombre: f.nombre || f.contacto,
          dias: Math.floor((Date.now() - new Date(f.fecha_hora_ultimo_mensaje).getTime()) / (24 * 60 * 60 * 1000))
        }))
      });

      await mongo.collection('fichas').updateMany(
        { _id: { $in: fichasFrias.map((f) => f._id) } },
        { $set: { aviso_fria_enviado: true } }
      );
      avisados++;
    } catch (err) {
      console.error(`No se pudo avisar fichas frías a ${cliente.slug}:`, err.message);
    }
  }
  if (avisados) console.log(`Fichas frías: ${avisados} cliente(s) avisados.`);
}

function iniciar() {
  const chequear = () => avisarFichasFrias().catch((err) => console.error('Error avisando fichas frías:', err));
  chequear();
  setInterval(chequear, 6 * 60 * 60 * 1000); // cada 6hs
}

module.exports = { iniciar, avisarFichasFrias };
