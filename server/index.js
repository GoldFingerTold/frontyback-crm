require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const db = require('./db');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const superadminRoutes = require('./routes/superadmin');

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

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

async function start() {
  await db.connect();
  app.listen(PORT, () => {
    console.log(`CRM de FrontyBack corriendo en http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('No se pudo arrancar el servidor:', err);
  process.exit(1);
});
