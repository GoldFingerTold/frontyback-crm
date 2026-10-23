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

- ✅ **Google Calendar: resuelto** (21/10). Causa real: el cliente OAuth
  original ("Cliente web 1", creado 18/10) tenía tildada una casilla nueva de
  Google llamada **"Use this client for an AI-powered agent"** - al
  destildarla Google pidió confirmar con un diálogo de advertencia ("may
  affect how your application works... may need to create a new client"),
  pero ni así se arregló (seguía "invalid_client"). Se terminó **borrando ese
  cliente y creando uno nuevo** (mismo tipo "Aplicación web", misma redirect
  URI `https://crm.frontyback.com/api/admin/calendar/google-callback`, SIN
  tildar esa casilla esta vez) - funcionó de inmediato. Client ID/Secret
  nuevos ya cargados en el `.env` del VPS. Probado de punta a punta: turno de
  prueba reservado → evento "Pedicuría - Celi" creado en el Google Calendar
  de Hugo (verificado contra la API, `timeMin/timeMax` del día del turno).
  Si algún otro cliente en el futuro reporta el mismo error con Google
  Calendar (u otro OAuth de Google), revisar primero esa casilla antes de
  nada más. Proyecto: `eighth-opus-391401` ("FrontyBack CRM" en Google
  Cloud).

- ✅ **Internacionalización: Hotmart para clientes fuera de Argentina -
  completo y verificado en producción** (21-22/10). La landing
  (`public/index.html`, `public/js/planes.js`) detecta el país del visitante
  (`geoip-lite`, `GET /api/public/geo`) y muestra ARS/Mercado Pago/formulario
  propio para Argentina, o USD/Hotmart para cualquier otro país (botones que
  van directo al checkout de Hotmart - ahí Hotmart maneja su propio período
  de prueba con tarjeta, no FrontyBack). Al confirmarse una compra
  (`POST /webhook/hotmart`), la cuenta se **crea sola** (usuario/contraseña
  generados, mandados por email) - no pasa por el formulario de alta. Una
  cancelación/reembolso entra al mismo período de gracia de 7 días que ya
  usa Mercado Pago (`db.cortarPorFaltaDePago`, sin cambios, ya era agnóstico
  de pasarela). `db.crearCliente` guarda `pasarela_pago` (default
  `'mercado_pago'`, no rompe ningún cliente existente) y `hotmart_data`.
  Los 8 links reales de checkout y el Hottok real ya están cargados en el
  `.env` del VPS (producto Hotmart `M108135502Y`).
  **Confirmado contra un webhook real** (22/10, sandbox de Hotmart,
  `PURCHASE_APPROVED` v2.0.0): el Hottok matchea, y el parseo de TODOS los
  campos (email, nombre, moneda, transacción, subscriber_code, estado,
  `purchase.offer.code`) salió exacto en el primer intento. A partir de esa
  prueba se mejoró `server/services/hotmart.js`: el plan comprado se
  identifica por el **código de oferta** (`purchase.offer.code`, vía
  `mapaOfertas()`/`identificarPlan()`) en vez de comparar montos - así
  funciona aunque el comprador pague en su moneda local (BRL, etc.) en vez
  de USD. `scripts/test-hotmart-webhook.js` incluye un caso que paga en BRL
  con el código de oferta real de un plan y confirma que identifica el plan
  correcto igual - corrido en local, todos los casos pasan.
  Pendiente de pulido (no bloqueante): las preguntas frecuentes de la
  landing siguen mencionando "7 días gratis, sin tarjeta" y "Mercado Pago"
  en los dos idiomas de la página, sin diferenciar para visitantes
  internacionales.

  **Override `?pais=otro` (22/10)**: `GET /api/public/geo` acepta
  `?pais=otro` y fuerza la vista internacional (USD/Hotmart, sin
  formulario de Mercado Pago) sin importar la IP real - pensado para dos
  casos: (1) que Hugo pueda previsualizar esa vista desde Argentina sin
  VPN, y (2) la "página de ventas" que pide Hotmart en la configuración
  del producto, que tiene que mostrar precios en USD de forma coherente
  con el checkout sin importar desde dónde la abran (la raíz de la
  landing sin el query param le muestra ARS/Mercado Pago a cualquiera que
  la abra desde Argentina, incoherente con un checkout en USD). Hugo ya
  cargó `https://crm.frontyback.com/?pais=otro` como página de ventas en
  el panel de Hotmart (22/10).

- **Landing en 3 idiomas (ES/EN/PT), construida y en producción** (21/10).
  Detección automática por país (`GET /api/public/geo` devuelve
  `idioma_sugerido`, países hispanohablantes → es, Brasil → pt, el resto →
  en) + selector manual en el header que pisa la detección y se guarda en
  cookie (`frontyback_idioma`, 1 año). Diccionarios en
  `public/i18n/{es,en,pt}.json` (incluyen nombre/descripción/features de
  cada plan, el precio sigue viniendo de Mongo). El idioma elegido queda
  guardado en `clientes.idioma` al dar de alta (por Mercado Pago o por
  Hotmart - en Hotmart se infiere de la moneda del cobro: BRL → pt, el
  resto → en por defecto, ya que no hay forma confiable de distinguir
  español de inglés solo con eso).
  `scripts/test-i18n.js` verifica que los 3 diccionarios tengan
  exactamente las mismas keys y que la detección por país funcione para
  varios continentes.
  **Alcance acordado explícitamente con Hugo**: por ahora SOLO la landing
  de ventas. El dashboard interno del CRM (tablero, turnos, etc.) y las
  respuestas automáticas de WhatsApp siguen en español - traducir
  WhatsApp requeriría que Meta apruebe una plantilla por idioma por cada
  WABA conectada, no es algo que el código resuelva solo. Si en algún
  momento se pide ampliar esto, confirmar bien el alcance antes de
  arrancar (cientos de strings por cada pantalla nueva que se sume).

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
  8. ✅ **Cobro de seña al reservar un turno** (20/10) - **probado de punta a
     punta con plata real** (cuenta de wye, $5 ARS): conexión OAuth, switch,
     monto, Checkout Pro, webhook confirma el pago contra la API con el token
     del propio negocio, turno pasa de `pendiente_pago` a `confirmado`, ficha
     creada, plata acreditada en la cuenta de Mercado Pago de wye (collector_id
     verificado) con liberación en ~18 días (política estándar de MP para
     cuentas nuevas en esto, no algo de la integración). Credenciales ya
     cargadas en el `.env` del VPS (`MERCADOPAGO_CONNECT_CLIENT_ID/SECRET/
     REDIRECT_URI`, reutilizando la misma Aplicación "FrontyBack CRM" que ya
     existía en Mercado Pago Developers, con la redirect URI agregada ahí en
     "Configuración de la aplicación" → "Configuración avanzada"). Nuevo:
     `server/services/mercadopagoConnect.js`,
     `turnos_config.sena_activa/sena_monto`, webhook
     `POST /webhook/mercadopago-turno`.

- **Ajustes post-prueba en vivo del 20/10** (todos desplegados, probados con
  wye + un contacto real pagando/reprogramando/cancelando un turno real):
  - El número de WhatsApp de wye nunca había completado el paso de
    `registrarNumero` (error 133010 "Account not registered") - se registró a
    mano, ya resuelto. Si otro cliente tiene el mismo síntoma (plantillas
    fallan con 133010 pero el número está "conectado"), correr
    `whatsapp.registrarNumero({ phoneNumberId, pin })` para ese número.
  - `reservar.html` y `mi-turno.html` mostraban "FrontyBack" en la vista
    previa de WhatsApp en vez del nombre del negocio (leen el `<title>`
    estático, sin ejecutar JS) - `server/index.js` ahora intercepta esas dos
    rutas antes del estático y les inyecta el nombre real + `og:title/
    description` cuando hay `?slug=`/`?token=` válido.
  - Reprogramar un turno desde `mi-turno.html` no avisaba nada ni actualizaba
    la ficha - ahora manda la misma confirmación por WhatsApp/email y
    refresca la ficha del tablero (sale de "fría" si estaba marcada así).
  - Botón de copiar el link de gestión del turno (🔗) en cada fila de la
    agenda de Turnos - para cuando un cliente pide cancelar/cambiar y perdió
    el link; a propósito NO se lo ofrece el sistema de forma proactiva (ver
    memoria `frontyback-crm-no-exponer-cancelacion`, Hugo prefiere no
    invitar a cancelar).
  - Switch "Recordatorio por WhatsApp" de Turnos se había apagado sin querer
    durante las pruebas - si un cliente reporta que no le llegan
    confirmaciones/recordatorios de turno, lo primero a chequear es ese
    switch en Turnos → Recordatorios.

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
