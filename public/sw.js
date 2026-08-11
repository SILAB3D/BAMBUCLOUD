/* eslint-env serviceworker */
/**
 * Service Worker del dashboard.
 *
 * Hace dos cosas:
 *   1. Cachea el armazon de la interfaz para que la PWA abra al instante y
 *      muestre algo cuando el movil no tiene datos.
 *   2. Recibe los Web Push y los muestra con la app cerrada, que es el motivo
 *      real de que exista: el aviso de "ya puedes retirar la pieza" llega 15
 *      minutos despues de que nadie este mirando la pantalla.
 *
 * Nunca se cachean las respuestas de /api ni la imagen de la camara: ahi el
 * dato viejo es peor que ningun dato.
 */

const CACHE = 'bambu-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Red primero: el dashboard tiene que reflejar el despliegue actual. La
  // cache solo entra cuando no hay red, para no quedarse en blanco.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        // Navegacion sin red y sin copia exacta: servimos el armazon.
        if (request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      }),
  );
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Bambu Lab';
  const options = {
    body: data.body || '',
    // `tag` colapsa avisos del mismo tipo: si el movil estuvo sin cobertura no
    // llegan cinco copias de "enfriando" de golpe.
    tag: data.tag || 'bambu',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: [90, 60, 90],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Si la PWA ya esta abierta se trae al frente en vez de abrir otra copia.
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// El navegador puede rotar la suscripcion por su cuenta; hay que reenviarla o
// los avisos dejan de llegar en silencio.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager
      .subscribe(event.oldSubscription?.options)
      .then((sub) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub }),
        }),
      )
      .catch(() => {}),
  );
});
