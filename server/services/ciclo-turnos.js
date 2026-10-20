// Manda el recordatorio de WhatsApp de un turno ~24hs antes de que sea, sin que nadie
// tenga que hacerlo a mano - mismo patrón de "barrido periódico" que ciclo-pagos.js.

const db = require('../db');
const turnosWhatsapp = require('./turnos');

const ARG_OFFSET_MS = -3 * 60 * 60 * 1000; // Argentina es UTC-3 fijo, sin horario de verano

// Convierte "fecha" (YYYY-MM-DD) + "hora_inicio" (HH:MM) del turno - ambos en hora de
// Buenos Aires - al instante UTC real, para poder compararlo contra "ahora".
function turnoAFechaUTC(fecha, hora) {
  const [y, m, d] = fecha.split('-').map(Number);
  const [h, min] = hora.split(':').map(Number);
  const estiloArg = Date.UTC(y, m - 1, d, h, min);
  return new Date(estiloArg - ARG_OFFSET_MS);
}

async function mandarRecordatoriosPendientes() {
  const mongo = db.getDb();
  const ahora = new Date();
  const desde = new Date(ahora.getTime() + 23 * 60 * 60 * 1000);
  const hasta = new Date(ahora.getTime() + 25 * 60 * 60 * 1000);

  // Traemos solo los turnos de los próximos 2 días de calendario (no toda la colección) -
  // el filtro fino por hora exacta se hace en memoria, con turnoAFechaUTC.
  const hoyStr = ahora.toISOString().slice(0, 10);
  const limiteStr = new Date(ahora.getTime() + 2 * 86400000).toISOString().slice(0, 10);

  const candidatos = await mongo.collection('turnos').find({
    estado: 'confirmado',
    recordatorio_enviado: false,
    fecha: { $gte: hoyStr, $lte: limiteStr }
  }).toArray();

  let enviados = 0;
  for (const turno of candidatos) {
    const momento = turnoAFechaUTC(turno.fecha, turno.hora_inicio);
    if (momento < desde || momento > hasta) continue;

    const cliente = await mongo.collection('clientes').findOne({ _id: turno.cliente_id });
    if (!cliente || !db.estadoPermiteRespuesta(cliente.estado_pago)) continue;

    const resultado = await turnosWhatsapp.enviarRecordatorio(cliente, turno);
    if (resultado.enviado) {
      await mongo.collection('turnos').updateOne({ _id: turno._id }, { $set: { recordatorio_enviado: true } });
      enviados++;
    }
  }
  if (enviados) console.log(`Ciclo de turnos: ${enviados} recordatorio(s) de WhatsApp enviados.`);
}

// Libera (cancela) los turnos que quedaron "pendiente_pago" (seña de Turnos) sin que
// nadie termine de pagar dentro de los 15 minutos - el horario ya deja de estar ocupado
// apenas vence (db.js, filtroEstadoOcupado lo chequea en el momento), esto solo limpia el
// registro para que no quede como un "pendiente_pago" fantasma para siempre en la agenda.
async function limpiarPagosVencidos() {
  const cancelados = await db.cancelarTurnosPagoVencido();
  if (cancelados) console.log(`Ciclo de turnos: ${cancelados} turno(s) sin pagar la seña a tiempo, cancelados.`);
}

function iniciar() {
  const chequear = () => {
    mandarRecordatoriosPendientes().catch((err) => console.error('Error mandando recordatorios de turnos:', err));
    limpiarPagosVencidos().catch((err) => console.error('Error limpiando turnos sin pagar la seña:', err));
  };
  chequear();
  setInterval(chequear, 60 * 60 * 1000); // cada 1 hora - la ventana de 23-25hs da margen de sobra
}

module.exports = { iniciar, mandarRecordatoriosPendientes };
