# CRM FrontyBack

CRM multi-cliente para ofrecer como servicio junto con los sitios: recibe consultas por
formulario web y por WhatsApp (texto y audio), responde automáticamente en cada canal, y
las organiza en un tablero tipo Kanban - una ficha por cliente final, que se puede
arrastrar de columna a medida que avanza (o no) la venta.

## Cómo funciona

- **Formulario**: cualquier sitio de FrontyBack puede apuntar su formulario de contacto a
  `POST /webhook/form/<slug-del-cliente>` con `{ nombre, email, mensaje }`. Se crea la
  ficha y se manda un email de autorespuesta (Resend) avisando que en breve lo van a
  atender.
- **WhatsApp (texto)**: Meta manda el mensaje al webhook, se crea/actualiza la ficha, y se
  responde automáticamente por WhatsApp con el mismo tipo de mensaje.
- **WhatsApp (audio)**: se transcribe con Whisper (OpenAI) para dejar registrado qué dijo
  el cliente, y se responde con un audio generado con voz femenina (ElevenLabs).
- Una persona que escribe más de una vez no genera fichas duplicadas - se identifica por
  email o teléfono y se le va sumando el historial a la misma ficha.

## Antes de arrancar - qué hay que dar de alta

**1) WhatsApp Business Cloud API (Meta)** - por cada cliente que se sume al servicio:
1. Meta for Developers → crear una app tipo "Business" → agregar el producto "WhatsApp".
2. Conectar el número de WhatsApp real del negocio (o generar uno de prueba mientras se
   desarrolla - Meta da un número de test gratis con contactos de prueba verificados).
3. Configurar el webhook: URL = `https://<dominio-del-crm>/webhook/whatsapp`,
   Verify Token = el mismo valor que se ponga en `WHATSAPP_VERIFY_TOKEN`.
4. Generar un token **permanente** (no el de 24hs) - se hace creando un "System User" en
   el Business Manager con permiso sobre la app, y generando su token desde ahí.
5. Copiar el `phone_number_id` que Meta le asigna a ese número - eso es lo que identifica
   a qué cliente pertenece cada mensaje que llega (se carga desde el super-admin, en la
   lista `whatsapp_numeros` del cliente - cada plan limita cuántos números puede tener
   conectados un mismo cliente al mismo tiempo).

**2) OpenAI** (para transcribir los audios) - una sola cuenta, compartida entre todos los
clientes del CRM. Generar una API key en platform.openai.com.

**3) ElevenLabs** (para la voz de las respuestas) - también una sola cuenta compartida.
Elegir o clonar una voz femenina en español y copiar su Voice ID.

## Instalación local

```
npm install
copy .env.example .env
```

Completá `.env` (ver `.env.example` para el detalle de cada variable) y después:

```
npm start
```

- Panel: http://localhost:3010

## Dar de alta un cliente nuevo

Desde `/superadmin.html` (usuario/contraseña propios, en `SUPERADMIN_USER` y
`SUPERADMIN_PASSWORD_HASH` del `.env` - no está en Mongo, hay un solo super-admin):
crear el cliente, conectar su(s) número(s) de WhatsApp una vez que los tenga en Meta
(hasta el tope de cuentas que permite su plan), y editar las columnas del tablero (agregar, renombrar, reordenar o borrar
etapas - si se borra una columna con fichas adentro, se migran solas a la primera
columna que quede).

También existe el script de línea de comandos, por si hace falta scriptear un alta:

```
node scripts/crear-cliente.js "<slug>" "<nombre del negocio>" "<email>" "<contraseña>"
```

## Pendiente / próximos pasos

- Diseño visual del tablero: ya tiene una primera versión (tema oscuro/dorado), se puede
  seguir puliendo.
