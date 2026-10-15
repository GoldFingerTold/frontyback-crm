# Estado del proyecto — FrontyBack CRM

Notas internas para que Claude (en cualquier compu) se ponga al día rápido si Hugo
necesita seguir trabajando desde una máquina distinta a la habitual. No es
documentación de producto, es una bitácora de contexto. Actualizarla al final de
sesiones importantes.

## Qué es esto

CRM multi-tenant para pequeños negocios (Express + MongoDB Atlas), vendido por
FrontyBack (la empresa de Hugo) como producto por suscripción. Vive en
`crm.frontyback.com`, corriendo en un VPS (PM2, proceso `crm-frontyback`) separado
de esta compu — si esta máquina no anda, el sitio en producción sigue funcionando
igual, no depende de que Hugo tenga la notebook prendida.

Repo: `github.com/GoldFingerTold/frontyback-crm` (todo el código queda ahí después
de cada cambio - clonarlo alcanza para tener el proyecto completo en cualquier PC).

## Cómo retomar en una máquina nueva

1. `git clone https://github.com/GoldFingerTold/frontyback-crm.git`
2. Leer este archivo + `git log --oneline -30` para ver qué se tocó último.
3. Las credenciales del VPS y las API keys (Mongo, Meta, OpenAI, ElevenLabs,
   MercadoPago, Resend) NO están en este repo por seguridad — las tiene Hugo.
   Preguntarle a él antes de intentar desplegar o tocar producción.
4. El patrón de deploy que se usa siempre: editar local → `node --check` al
   archivo tocado → commit (autor forzado a nombre de Hugo) → push → SSH al VPS
   (`git pull && pm2 restart crm-frontyback`) → verificar que el restart count subió
   y quedó "online" unos segundos después, no reiniciando en loop.

## Arquitectura / decisiones clave (por si no son obvias leyendo el código)

- **4 planes**: Esencial ($15.000 ARS/mes) / Profesional ($30.000) / Premium
  ($45.000) / Elite ($60.000). Cada uno tiene `limite_turnos_mensajes_mes` y
  `limite_audios_mes` proporcional (150/300/450/600).
- **WhatsApp se conecta con Embedded Signup vía JS SDK** (`public/conectar-whatsapp.html`),
  NO con el link hosteado de Meta (`business.facebook.com/messaging/whatsapp/onboard`,
  que nunca redirige de vuelta - se probó y no funciona, no insistir con eso).
- **Quién paga los mensajes de WhatsApp de turnos**: desde oct/2026 se confirmó en
  vivo (cuenta de wye) que cada cliente tiene su propia "Messaging Account" en Meta
  Business Manager, con su propio método de pago — Meta le cobra a ÉL el excedente
  de recordatorios de turno, no a FrontyBack. Por eso el tope de turnos ya NO corta
  el envío, es solo informativo (ver `server/services/turnos.js`). Si el cliente no
  cargó tarjeta en Meta, el envío falla con error 131042, lo detectamos y se lo
  avisamos en el panel (banner + `whatsapp_pago_pendiente` en `clientes`).
- **Quién paga el audio (transcripción OpenAI + voz ElevenLabs)**: eso sí sale del
  bolsillo de FrontyBack (API key propia), así que ahí el tope por plan SÍ corta de
  verdad (`server/routes/webhooks.js`, `db.maxAudiosMesDeCliente`).
- **"Consultas" de texto normal no tienen costo real** (son mensajes de sesión,
  siempre gratis para el negocio dentro de la ventana de 24hs) — el número que se
  muestra en el plan ("Hasta 300 consultas por mes", etc.) es solo texto comercial,
  no hay ningún control técnico detrás ni falta que lo haya.
- **Verificación de acceso de Meta** (Tech Provider status): quedó en revisión hace
  varios días, pasado el estimado de 5 días hábiles de Meta. Se confirmó leyendo la
  doc oficial que no falta ningún paso de nuestro lado, solo esperar (o abrir un
  ticket a soporte de Meta si se extiende mucho más).

## Pendiente / abierto

- Conseguir el precio exacto por mensaje "Utility" para Argentina desde la
  calculadora oficial de Meta (`business.whatsapp.com/products/platform-pricing`,
  elegir Argentina + ARS + Utility) — es una tabla interactiva en JS, no se pudo
  leer por web fetch, Hugo lo tiene que mirar él mismo en el navegador.
- Confirmar si el tope de "Billing Hub" (moneda + método de pago) hay que
  configurarlo una vez por cliente o si hay alguna otra sutileza — solo se probó
  con la cuenta de wye (que es del propio Hugo), falta confirmarlo con un cliente
  externo real.

## Memoria de Claude

Hay un sistema de memoria persistente aparte (archivos locales en esta compu,
`C:\Users\Hugo\.claude\projects\...\memory\`) con preferencias de Hugo y contexto
de negocio que NO viaja a otra máquina. Si Claude arranca en una compu nueva sin
esa memoria, este archivo + el código + preguntarle a Hugo alcanza para retomar
sin perder nada importante.
