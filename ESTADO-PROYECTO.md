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
- **Quién paga los mensajes de WhatsApp de turnos**: cada cliente tiene su propia
  "Messaging Account" en Meta Business Manager, con su propio método de pago — Meta le
  cobra a ÉL, no a FrontyBack. El tope de turnos ya NO corta el envío, es solo
  informativo (ver `server/services/turnos.js`). Si el cliente no cargó tarjeta en
  Meta, el envío falla con error 131042, lo detectamos y se lo avisamos en el panel
  (banner + `whatsapp_pago_pendiente` en `clientes`).
- **No hay ningún tramo gratis en los mensajes de turno por WhatsApp**: tanto la
  confirmación como el recordatorio son mensajes proactivos (el negocio los inicia, no
  son respuesta a algo que el cliente escribió - la reserva llega por un formulario
  web, no por WhatsApp), así que los dos entran en la regla de "Meta cobra fuera de las
  24hs desde el último mensaje del cliente" desde el primer envío. Precio real
  confirmado en vivo (18/10/2026, calculadora oficial de Meta): **≈ $37,68 ARS (USD
  0,026) por mensaje**, categoría Utilidad, tramo 0-120.000 mensajes/mes (el único que
  le aplica a cualquier cliente de FrontyBack). Este número vive hardcodeado en el
  texto de 3 pantallas (`turnos.html`, `tablero.js`, `conectar-whatsapp.html`) - si
  Meta actualiza la tarifa (lo hacen como máximo 1 vez por trimestre), hay que
  actualizarlo a mano en esos 3 lugares.
- **Switches de recordatorio de turno** (`turnos_config.recordatorio_whatsapp` /
  `recordatorio_email`): WhatsApp arranca APAGADO por defecto para cuentas nuevas (tiene
  costo real), email arranca PRENDIDO (sin costo, Resend). Cuentas que ya usaban Turnos
  antes de este cambio mantuvieron el WhatsApp prendido (no se les cortó algo que ya
  tenían).
- **Quién paga el audio (transcripción OpenAI + voz ElevenLabs)**: eso sí sale del
  bolsillo de FrontyBack (API key propia) - a diferencia de WhatsApp, acá SÍ hay un
  tramo genuinamente gratis para el cliente (hasta 300/450/600 según el plan, pagado
  por FrontyBack), y el tope por plan SÍ corta de verdad al llegar ahí
  (`server/routes/webhooks.js`, `db.maxAudiosMesDeCliente`). No confundir los dos
  modelos: Meta cobra por WhatsApp desde el mensaje 1, FrontyBack cubre audio hasta un
  tope real.
- **"Consultas" de texto normal no tienen costo real** (son mensajes de sesión,
  siempre gratis para el negocio dentro de la ventana de 24hs) - no aparece ningún
  número de "consultas incluidas" en la landing, se sacó por no representar nada real.
- **Verificación de Meta: todo resuelto** (18/10/2026) - App Review (3 permisos),
  Verificación de acceso (Tech Provider) y Acciones requeridas, los tres en estado
  aprobado/completado. No queda ningún trámite pendiente de Meta.

## Pendiente / abierto

- **Probar a fondo Google Calendar con un turno real** (recién integrado el 18/10):
  conectado vía OAuth2 desde Turnos → Conectar Google Calendar, cada turno reservado
  crea un evento. Verificado que compila y despliega, falta la prueba end-to-end de
  Hugo reservando un turno real y confirmando que el evento aparece en su calendario.
  Credenciales ya cargadas en el `.env` del VPS (`GOOGLE_CLIENT_ID`/`_SECRET`/
  `_REDIRECT_URI`). Mientras la app de Google siga en modo "Prueba" (no verificada),
  los clientes van a ver un cartel de advertencia de Google al conectar - normal, no es
  un error.

- Confirmar si el tope de "Billing Hub" (moneda + método de pago) hay que
  configurarlo una vez por cliente o si hay alguna otra sutileza — solo se probó
  con la cuenta de wye (que es del propio Hugo), falta confirmarlo con un cliente
  externo real.
- Hugo va a empezar a contactar prospectos ahora que está todo publicado (precio real
  de WhatsApp, verificación de Meta resuelta, alta 100% autoservicio con botón de
  conectar WhatsApp en el propio tablero) - sin tareas técnicas concretas todavía,
  pendiente de ver qué feedback trae eso.

## Memoria de Claude

Hay un sistema de memoria persistente aparte (archivos locales en esta compu,
`C:\Users\Hugo\.claude\projects\...\memory\`) con preferencias de Hugo y contexto
de negocio que NO viaja a otra máquina. Si Claude arranca en una compu nueva sin
esa memoria, este archivo + el código + preguntarle a Hugo alcanza para retomar
sin perder nada importante.
