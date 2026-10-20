require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const asyncHandler = require('./asyncHandler');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const superadminRoutes = require('./routes/superadmin');
const publicRoutes = require('./routes/public');
const salonRoutes = require('./routes/salon');
const turnosRoutes = require('./routes/turnos');
const catalogoRoutes = require('./routes/catalogo');
const fidelidadRoutes = require('./routes/fidelidad');
const cicloPagos = require('./services/ciclo-pagos');
const cicloTurnos = require('./services/ciclo-turnos');
const cicloResumen = require('./services/ciclo-resumen');
const cicloFichasFrias = require('./services/ciclo-fichas-frias');

const app = express();
const PORT = process.env.PORT || 3010;

// El servidor corre siempre detrás del nginx de CloudPanel (local o en el VPS), que manda
// la IP real del visitante en X-Forwarded-For. Sin esto, req.ip (y con él, todo el rate
// limiting) vería siempre 127.0.0.1 para todo el mundo - "trust proxy: 1" le dice a Express
// que confíe en un solo salto de proxy delante suyo (el de nginx), no en cualquier IP que
// alguien se invente en el header.
app.set('trust proxy', 1);

app.use(cors({ credentials: true, origin: true }));

// El webhook de WhatsApp necesita el body "crudo" para poder verificar la firma que
// manda Meta (X-Hub-Signature-256) antes de confiar en el contenido - por eso ese router
// se monta ANTES del express.json() general, con su propio parser.
app.use('/webhook', webhookRoutes);

app.use(express.json());
app.use(
  session({
    name: 'frontyback-crm.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-cambiar-en-produccion',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/salon', salonRoutes);
app.use('/api/turnos', turnosRoutes);
app.use('/api/catalogo', catalogoRoutes);
app.use('/api/fidelidad', fidelidadRoutes);

// La landing de ventas pasó de /planes.html a la raíz (mejor para SEO: el dominio raíz es
// lo que Google indexa con más fuerza, y es la URL que la gente comparte/recuerda).
// Esto evita un 404 si alguien ya tenía guardado el link viejo.
app.get('/planes.html', (req, res) => res.redirect(301, '/'));

// El archivo reservar.html es el mismo para todos los negocios (el nombre lo carga el JS
// recién después de pedirle /api/public/turnos/:slug/config) - pero WhatsApp, Facebook, etc.
// arman la vista previa del link leyendo el <title>/<meta og:*> del HTML tal como llega del
// servidor, SIN ejecutar ese JS. Sin esto, cualquier negocio que comparta su link de
// reservas por WhatsApp muestra "FrontyBack" en la vista previa en vez de su propio nombre -
// se ve poco profesional para un cliente del CRM. Esta ruta va ANTES del estático: si hay un
// ?slug= válido, inyecta el nombre del negocio en el HTML antes de servirlo; si no, cae al
// archivo estático de siempre (next()), con el título genérico de FrontyBack.
app.get('/reservar.html', asyncHandler(async (req, res, next) => {
  const slug = String(req.query.slug || '').trim();
  if (!slug) return next();

  const cliente = await db.getDb().collection('clientes').findOne({ slug });
  if (!cliente) return next();

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titulo = `Reservar turno — ${esc(cliente.nombre)}`;
  const descripcion = `Reservá tu turno online en ${esc(cliente.nombre)}.`;

  let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'reservar.html'), 'utf-8');
  html = html.replace('<title>Reservar turno — FrontyBack</title>', `<title>${titulo}</title>
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${descripcion}">`);

  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

async function start() {
  await db.connect();
  cicloPagos.iniciar();
  cicloTurnos.iniciar();
  cicloResumen.iniciar();
  cicloFichasFrias.iniciar();
  app.listen(PORT, () => {
    console.log(`CRM de FrontyBack corriendo en http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('No se pudo arrancar el servidor:', err);
  process.exit(1);
});
