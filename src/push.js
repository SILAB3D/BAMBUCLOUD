/**
 * Web Push (VAPID).
 *
 * La Notification API del navegador solo dispara con la pestana abierta, asi
 * que el aviso importante — "la pieza ya se puede retirar" — no llegaria nunca
 * al movil. Web Push lo entrega el push service del navegador (FCM, Mozilla,
 * Apple) y el Service Worker lo muestra con la PWA cerrada.
 *
 * Requisitos: origen HTTPS y, en iOS, que la web este anadida a la pantalla de
 * inicio (Safari no permite push desde una pestana normal).
 */

import webpush from 'web-push';

export class PushHub {
  /**
   * @param {object} opts
   * @param {string} [opts.publicKey] VAPID_PUBLIC_KEY
   * @param {string} [opts.privateKey] VAPID_PRIVATE_KEY
   * @param {string} [opts.subject] mailto: de contacto que exige el estandar
   * @param {import('./store.js').Store} [opts.store]
   */
  constructor(opts = {}) {
    this.publicKey = opts.publicKey || null;
    this.privateKey = opts.privateKey || null;
    this.store = opts.store || null;
    this.subject = opts.subject || 'mailto:admin@localhost';

    this.enabled = Boolean(this.publicKey && this.privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
    } else {
      console.warn('[push] sin VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY: Web Push desactivado');
    }
  }

  get subscriptions() {
    return this.store?.get('pushSubs') || [];
  }

  set subscriptions(list) {
    this.store?.set('pushSubs', list);
    // Se escribe ya: perder una suscripcion recien dada de alta significa que
    // ese movil se queda sin avisos sin que nada lo indique.
    this.store?.flush();
  }

  get count() {
    return this.subscriptions.length;
  }

  /** Alta idempotente: el navegador reenvia la misma suscripcion en cada carga. */
  subscribe(sub) {
    if (!sub?.endpoint) return { ok: false, error: 'Suscripcion invalida' };
    const list = this.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, keys: sub.keys, at: Date.now() });
    this.subscriptions = list;
    return { ok: true, count: list.length };
  }

  unsubscribe(endpoint) {
    const list = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    this.subscriptions = list;
    return { ok: true, count: list.length };
  }

  /**
   * Envia a todos los dispositivos registrados.
   * Un 404/410 significa que esa suscripcion ya no existe (app desinstalada,
   * permisos revocados): se borra en vez de reintentarla eternamente.
   */
  async send(payload) {
    if (!this.enabled) return { sent: 0, removed: 0 };
    const subs = this.subscriptions;
    if (!subs.length) return { sent: 0, removed: 0 };

    const body = JSON.stringify(payload);
    const dead = [];
    let sent = 0;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
          sent += 1;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
          else console.error('[push]', err.statusCode || '', err.message);
        }
      }),
    );

    if (dead.length) {
      this.subscriptions = subs.filter((s) => !dead.includes(s.endpoint));
    }
    return { sent, removed: dead.length };
  }
}
