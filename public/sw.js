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

const CACHE = 'bambu-shell-v5';
// Sin '/index.html': el servidor lo entrega en '/', y pedir los dos en el
// mismo addAll hace que el navegador aborte la instalacion entera con
// "Entry already exists". Un Service Worker que no instala no solo deja de
// cachear: tampoco recibe los push, que es lo que de verdad importa aqui.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  // El badge se pinta con la app cerrada y puede tocar sin red: mejor tenerlo.
  '/badge-96.png',
];

// Nada de lo que tenga que ver con la cache puede tumbar la instalacion: si
// `waitUntil` recibe una promesa rechazada, el worker no llega a activarse, y
// un worker inactivo tampoco recibe los push. La cache es una comodidad; el
// aviso de "ya puedes retirarla" no lo es. Por eso todo va con su red debajo.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Uno a uno y tolerando fallos: que falte un icono no puede impedir que
      // el worker se active.
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => {}))))
      .catch((err) => console.warn('[sw] sin cache de armazon:', err.message))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .catch(() => {})
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
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        try {
          const hit = await caches.match(request);
          if (hit) return hit;
          // Navegacion sin red y sin copia exacta: servimos el armazon.
          if (request.mode === 'navigate') {
            const shell = await caches.match('/');
            if (shell) return shell;
          }
        } catch { /* sin cache disponible: no hay nada que ofrecer */ }
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
    // El badge de la barra de estado es una mascara: Android ignora el color y
    // pinta la silueta que marque el canal alfa. Con el icono normal, opaco de
    // borde a borde, salia un cuadrado gris macizo; este es el cubo recortado
    // sobre transparente.
    badge: '/badge-96.png',
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
