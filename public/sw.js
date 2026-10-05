// Service worker del CRM: lo mínimo para que el sitio sea instalable como PWA, y el
// manejo de notificaciones push (avisos de leads nuevos al instante).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Sin caché propio - el CRM siempre necesita datos frescos (fichas, estado de pago), así
// que cachear de más haría más mal que bien. Esto solo deja pasar los pedidos normales,
// pero ya alcanza para que el navegador considere el sitio instalable.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let data = { title: 'CRM FrontyBack', body: 'Tenés una consulta nueva.', url: '/tablero.html' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // si no vino como JSON por algún motivo, se usa el genérico de arriba
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url }
    })
  );
});

// Si ya hay una pestaña del CRM abierta, la enfoca en vez de abrir una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/tablero.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).pathname === url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
