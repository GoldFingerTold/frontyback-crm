// Sincronización de Turnos con Google Calendar: cada cliente conecta SU PROPIO calendario
// (OAuth2, scope solo de eventos) y cada turno reservado se crea ahí como evento. No es
// bidireccional (si borran el evento en Google no se cancela el turno acá) - alcanza con
// crear, que es lo que resuelve el "se me olvida mirar el CRM para saber qué tengo hoy".

const db = require('../db');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Faltan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI en el .env.');
  }
  return { clientId, clientSecret, redirectUri };
}

// El "state" es el id del cliente en texto plano - no es un secreto (no da acceso a nada
// por sí solo), solo identifica a qué cuenta del CRM hay que atar el calendario que se
// autorice. Pedir el flujo ya requiere estar logueado como Gerencia de esa cuenta.
function getAuthUrl(clienteId) {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline', // para que devuelva refresh_token
    prompt: 'consent', // fuerza a que SIEMPRE devuelva refresh_token (si no, solo la primera vez)
    scope: SCOPE,
    state: String(clienteId)
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function intercambiarCodigo(code) {
  const { clientId, clientSecret, redirectUri } = config();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error canjeando el código de Google: ${JSON.stringify(data)}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refrescarToken(refreshToken) {
  const { clientId, clientSecret } = config();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error refrescando el token de Google: ${JSON.stringify(data)}`);
  return data; // { access_token, expires_in, ... } - NO devuelve refresh_token de nuevo
}

// Devuelve un access_token válido para este cliente, refrescándolo si ya venció - así
// quien llama nunca tiene que preocuparse por la expiración (dura solo 1 hora).
async function getAccessTokenValido(cliente) {
  if (!cliente.google_calendar_refresh_token) return null;

  const vigente = cliente.google_calendar_token_expira && new Date(cliente.google_calendar_token_expira) > new Date();
  if (vigente) return cliente.google_calendar_access_token;

  const data = await refrescarToken(cliente.google_calendar_refresh_token);
  const expira = new Date(Date.now() + (data.expires_in - 60) * 1000); // 1 min de margen
  await db.getDb().collection('clientes').updateOne(
    { _id: cliente._id },
    { $set: { google_calendar_access_token: data.access_token, google_calendar_token_expira: expira } }
  );
  return data.access_token;
}

function formatearFechaHoraArg(fecha, hora) {
  // "fecha" YYYY-MM-DD y "hora" HH:MM ya están en hora de Argentina - Google Calendar
  // acepta la hora local + la zona horaria aparte, sin tener que convertir a UTC acá.
  return `${fecha}T${hora}:00`;
}

// Crea el evento - mejor esfuerzo: si falla (token revocado, etc.) no tiene que frenar la
// reserva del turno, que ya quedó guardada en el CRM antes de llamar a esto.
async function crearEventoTurno(cliente, turno) {
  const accessToken = await getAccessTokenValido(cliente);
  if (!accessToken) return { creado: false, motivo: 'sin_conectar' };

  const evento = {
    summary: `${turno.servicio_nombre} - ${turno.nombre_contacto}`,
    description: `Reservado por ${turno.nombre_contacto} (${turno.telefono_contacto}) a través del CRM de FrontyBack.`,
    start: { dateTime: formatearFechaHoraArg(turno.fecha, turno.hora_inicio), timeZone: 'America/Argentina/Buenos_Aires' },
    end: { dateTime: formatearFechaHoraArg(turno.fecha, turno.hora_fin), timeZone: 'America/Argentina/Buenos_Aires' }
  };

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(evento)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`No se pudo crear el evento de Google Calendar para el turno de ${cliente.slug}:`, JSON.stringify(data));
    return { creado: false, motivo: 'error_api' };
  }
  return { creado: true, eventoId: data.id };
}

module.exports = { getAuthUrl, intercambiarCodigo, getAccessTokenValido, crearEventoTurno };
