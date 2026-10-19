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

- **Google Calendar: resolver "Error 401: invalid_client"** (sesión del 18/10 a la
  noche, sin resolver). La integración está programada y desplegada
  (`server/services/googleCalendar.js`, botón en Turnos), credenciales cargadas en
  el `.env` del VPS, el Client ID coincide exacto entre Google Cloud Console y lo que
  lee el proceso en vivo (verificado). Probamos: esperar propagación (no sirvió),
  activar la cuenta de Google Cloud (tenía el trial vencido - no sirvió), agregar a
  Hugo como usuario de prueba (no sirvió). El error pasó de "invalid_client" genérico
  a "The OAuth client was not found" y volvió a "invalid_client" - parece intermitente,
  no un error de configuración nuestra. Dos cosas para probar mañana, en orden:
  1. Revisar **"Información de la marca"** en Google Auth Platform por si falta algún
     campo obligatorio.
  2. Si no, **borrar el cliente OAuth y crear uno nuevo** (hay reportes de clientes
     creados por la interfaz nueva de Google que quedan "pegados").
  Proyecto: `eighth-opus-391401` ("FrontyBack CRM" en Google Cloud).

- **Integración de Meta Lead Ads** (pedida 18/10 a la noche, sin empezar): que un
  cliente pueda conectar su campaña de Facebook/Instagram Ads y que los leads de sus
  formularios instantáneos entren solos como fichas al CRM, en vez de quedar en el
  Excel que Meta deja descargar a mano (y borra a los 90 días). Reusa la misma App de
  Meta que ya tenemos ("Ai") - no hace falta una cuenta nueva. Falta: (1) pedir el
  permiso `leads_retrieval` para la app (mismo tipo de trámite ya hecho con
  `whatsapp_business_management` - funciona en modo prueba con la propia página de
  Hugo sin esperar aprobación), (2) suscribir el webhook de la app al campo `leadgen`,
  (3) programar: botón "Conectar campaña de Meta Ads" (Facebook Login, mismo patrón
  que conectar-whatsapp.html), extender `server/routes/webhooks.js` para manejar
  eventos `leadgen` además de los de WhatsApp, y un mapeo automático de las preguntas
  del formulario a nombre/teléfono/email (parecido al mapeo que se hizo para la
  importación de CSV).

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
