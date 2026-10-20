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

- **Integración de Meta Lead Ads: construida y conectada, falta la prueba end-to-end**
  (19/10). Se programó todo (`server/services/metaLeads.js`, webhook extendido en
  `server/routes/webhooks.js` para distinguir `object: "page"` vs
  `"whatsapp_business_account"` en la misma URL, botón "Conectar campaña de Meta Ads"
  en el tablero, página `public/conectar-meta-ads.html`). Del lado de Meta ya quedó
  todo configurado: caso de uso "Atrae y administra clientes potenciales" agregado,
  los 5 permisos (`leads_retrieval`, `pages_manage_ads`, `pages_manage_metadata`,
  `pages_read_engagement`, `pages_show_list`) en "Listo para prueba", webhook
  suscripto al campo `leadgen`. Se probó la conexión real con dos páginas de wye
  ("www.webyeventos.com.ar" y "Mujer Poderosa") y quedaron guardadas correctamente en
  `clientes.meta_pages` (verificado en la base). Lo único que falta: generar un lead
  de prueba real para confirmar que el webhook dispara y crea la ficha - se intentó
  con la Lead Ads Testing Tool de Meta (`developers.facebook.com/tools/lead-ads-testing`)
  pero no reconocía el formulario de prueba recién creado (puede haber quedado en una
  página distinta a la seleccionada - revisar a qué página pertenece el formulario
  "Sin título 19/10/26" antes de seguir insistiendo, o directamente esperar un lead
  real de una campaña de Hugo).

- Confirmar si el tope de "Billing Hub" (moneda + método de pago) hay que
  configurarlo una vez por cliente o si hay alguna otra sutileza — solo se probó
  con la cuenta de wye (que es del propio Hugo), falta confirmarlo con un cliente
  externo real.
- **Tanda de funciones nuevas acordada el 19/10 ("sumamos las 3... a lo propuesto
  por vos")** — en construcción el 20/10, items 1-3 ya hechos y desplegados:
  1. ✅ **Responder manualmente por WhatsApp desde la ficha** (20/10) - botón en la
     ficha, manda mensaje de sesión (gratis) si está dentro de las 24hs; si pasaron,
     cae automático a la plantilla `seguimiento_consulta` (con costo, igual que
     turnos) para no perder la conversación. Template verificado como APPROVED en
     Meta (estaba PENDING el día que se creó).
  2. ✅ **Asignar una ficha a un empleado puntual** (20/10) - selector en la ficha,
     endpoint `GET /usuarios/asignables` (gerencia ve todos, el resto solo su
     departamento) + `PUT /fichas/:id/asignar`.
  3. ✅ **Seguimiento activo de fichas frías** (20/10) - antes solo había el ícono
     visual del tablero, ahora `server/services/ciclo-fichas-frias.js` corre cada
     6hs y manda un email agrupado (mismo switch `avisos_lead_email`) cuando una
     ficha lleva más de 5 días sin mensaje nuevo en una columna activa. Se dedupe con
     `ficha.aviso_fria_enviado`, que se resetea solo al volver a tener actividad real
     (mensaje nuevo en `fichas.js` o mover de columna en `admin.js`).
  4. ✅ **Reportes de tiempo de respuesta** en Estadísticas (20/10) - mide desde
     que llega un lead nuevo por WhatsApp hasta que alguien responde A MANO desde
     la ficha (`ficha.primera_respuesta_manual`, se guarda una sola vez). No cuenta
     la autorespuesta automática, que es instantánea y no refleja atención real.
     Gráfico nuevo en Estadísticas: promedio + distribución en baldes de horas
     (<1h / 1-6h / 6-24h / >24h).
  5. ✅ **Mensajes segmentados por etiqueta** (20/10) - botón "Mensajes por
     etiqueta" en el tablero (solo Gerencia): elige una etiqueta (ej. "VIP") y
     manda el mismo texto por WhatsApp a todos los contactos que la tengan. Mismo
     esquema de costo que "responder manualmente" (gratis si está dentro de las
     24hs, plantilla con costo si no). Endpoints nuevos: `GET /api/admin/etiquetas`,
     `POST /api/admin/mensajes-masivos`.
  6. ✅ **Elegir profesional al reservar un turno** (20/10) - sección nueva
     "Profesionales" en Turnos (Gerencia): cada uno con su propio horario semanal.
     Apenas hay uno o más, `reservar.html` pide elegir con quién antes de mostrar
     horarios, y los choques se chequean por profesional (dos pueden tener un
     turno a la misma hora). Sin profesionales configurados, sigue funcionando
     igual que antes (un solo horario compartido) - no rompe nada para los
     clientes que ya usaban Turnos. `turnos_config.profesionales`,
     `PUT /api/turnos/profesionales`, `turno.profesional_id/profesional_nombre`.
  7. ✅ **El cliente final puede cancelar/reprogramar su propio turno** (20/10) -
     página nueva `public/mi-turno.html`, accesible por un token sin login
     (`turno.token_gestion`, generado en `crearTurno`). El link aparece en la
     pantalla de éxito al reservar y en los emails de confirmación/recordatorio
     (turnos de antes de este cambio no tienen token, no rompe nada - simplemente
     no muestran el botón). Reprogramar reusa `horariosDisponibles` para
     revalidar el horario elegido, misma lógica que ve el cliente al reservar.
     Rutas nuevas bajo `/api/public/turnos/gestionar/:token`.
  8. **Cobro de seña al reservar un turno**, con **switch de activar/desactivar**
     (mismo patrón que los switches de recordatorio WhatsApp/email) - con la cuenta
     de MercadoPago del propio negocio, no la de FrontyBack. Tercera idea de
     AgendaPro.

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
