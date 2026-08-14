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
 *
 * Cada suscripcion se guarda como un "dispositivo" con nombre legible y un
 * interruptor propio: desde el panel de administracion se puede silenciar un
 * movil concreto sin tocar los avisos de los demas.
 */

import crypto from 'node:crypto';
import webpush from 'web-push';

/**
 * Identificador estable de un dispositivo.
 *
 * El endpoint es larguisimo y lleva el token del push service dentro, asi que
 * no puede viajar al navegador como identificador. Un hash suyo si: es corto,
 * no revela nada y sobrevive a los reinicios porque se deriva del propio dato.
 */
function deviceId(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
}

/**
 * Nombre legible a partir del user-agent.
 *
 * No pretende ser exacto — es lo que se lee en una lista para distinguir "el
 * movil" de "el portatil". El orden importa: Edge y Opera tambien dicen ser
 * Chrome, y Chrome tambien dice ser Safari.
 */
export function describeDevice(ua = '', hints = {}) {
  const s = String(ua);

  let browser = 'Navegador';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/firefox|fxios/i.test(s)) browser = 'Firefox';
  else if (/chrome|crios/i.test(s)) browser = 'Chrome';
  else if (/safari/i.test(s)) browser = 'Safari';

  let os = 'dispositivo';
  if (/iphone/i.test(s)) os = 'iPhone';
  else if (/ipad/i.test(s)) os = 'iPad';
  else if (/android/i.test(s)) os = 'Android';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(s)) os = 'Mac';
  else if (/linux/i.test(s)) os = 'Linux';

  const label = `${browser} · ${os}`;
  // "App instalada" frente a "pestana del navegador" es justo lo que explica
  // por que en un iPhone llegan los avisos y en el de al lado no.
  return hints.standalone ? `${label} (app instalada)` : label;
}

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
    const list = this.store?.get('pushSubs') || [];
    // Migracion en caliente: las suscripciones guardadas antes de que
    // existieran los dispositivos no tienen id ni interruptor.
    return list.map((s) => ({
      ...s,
      id: s.id || deviceId(s.endpoint),
      enabled: s.enabled !== false,
      label: s.label || describeDevice(s.ua, s),
    }));
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

  /** Los que recibirian un aviso ahora mismo. */
  get activeCount() {
    return this.subscriptions.filter((s) => s.enabled !== false).length;
  }

  /** Lista para el panel: sin endpoint ni claves de cifrado. */
  get devices() {
    return this.subscriptions
      .map((s) => ({
        id: s.id,
        label: s.label,
        enabled: s.enabled !== false,
        at: s.at || null,
        lastSeen: s.lastSeen || s.at || null,
        standalone: Boolean(s.standalone),
      }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  /**
   * Alta idempotente: el navegador reenvia la misma suscripcion en cada carga.
   *
   * Al renovar se conserva el interruptor. Si no, cualquier dispositivo
   * silenciado desde el panel se volveria a encender solo con que su dueno
   * abriera la app.
   *
   * @param {object} sub suscripcion del PushManager
   * @param {object} [info] { ua, standalone } que manda el cliente
   */
  subscribe(sub, info = {}) {
    if (!sub?.endpoint) return { ok: false, error: 'Suscripcion invalida' };
    if (!sub.keys?.p256dh || !sub.keys?.auth) {
      return { ok: false, error: 'Suscripcion sin claves de cifrado' };
    }
    const all = this.subscriptions;
    const prev = all.find((s) => s.endpoint === sub.endpoint);
    const list = all.filter((s) => s.endpoint !== sub.endpoint);

    const entry = {
      id: prev?.id || deviceId(sub.endpoint),
      endpoint: sub.endpoint,
      keys: sub.keys,
      at: prev?.at || Date.now(),
      lastSeen: Date.now(),
      enabled: prev ? prev.enabled !== false : true,
      ua: info.ua || prev?.ua || '',
      standalone: info.standalone ?? prev?.standalone ?? false,
      label: describeDevice(info.ua || prev?.ua || '', {
        standalone: info.standalone ?? prev?.standalone ?? false,
      }),
    };
    list.push(entry);
    this.subscriptions = list;

    // Rastro en el log: al depurar "no me llegan los avisos" lo primero que
    // hay que saber es si el alta llego siquiera al servidor.
    console.log(
      `[push] ${prev ? 'renovacion' : 'alta'} de ${entry.label} ` +
        `(${list.length} en total) · ${sub.endpoint.slice(0, 48)}…`,
    );
    return { ok: true, count: list.length, id: entry.id, enabled: entry.enabled };
  }

  unsubscribe(endpoint) {
    const list = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    this.subscriptions = list;
    return { ok: true, count: list.length };
  }

  /** Silencia o reactiva un dispositivo desde el panel. */
  setEnabled(id, enabled) {
    const list = this.subscriptions;
    const target = list.find((s) => s.id === id);
    if (!target) return { ok: false, error: 'Dispositivo no encontrado' };
    target.enabled = Boolean(enabled);
    this.subscriptions = list;
    console.log(`[push] ${target.label} ${target.enabled ? 'activado' : 'silenciado'}`);
    return { ok: true, id, enabled: target.enabled };
  }

  /** Saca un dispositivo del registro. Volvera si su dueno abre la app. */
  remove(id) {
    const list = this.subscriptions;
    const target = list.find((s) => s.id === id);
    if (!target) return { ok: false, error: 'Dispositivo no encontrado' };
    this.subscriptions = list.filter((s) => s.id !== id);
    console.log(`[push] ${target.label} eliminado del registro`);
    return { ok: true, count: this.count };
  }

  /**
   * Envia a los dispositivos registrados y activos.
   *
   * Un 404/410 significa que esa suscripcion ya no existe (app desinstalada,
   * permisos revocados): se borra en vez de reintentarla eternamente.
   *
   * @param {object} payload
   * @param {object} [opts]
   * @param {string} [opts.only] id de un unico dispositivo (prueba del panel)
   * @param {boolean} [opts.ignoreEnabled] enviar aunque este silenciado
   */
  async send(payload, { only = null, ignoreEnabled = false } = {}) {
    if (!this.enabled) return { sent: 0, removed: 0, skipped: 0 };
    const all = this.subscriptions;
    const targets = all.filter((s) => {
      if (only && s.id !== only) return false;
      return ignoreEnabled || s.enabled !== false;
    });
    const skipped = (only ? all.filter((s) => s.id === only) : all).length - targets.length;
    if (!targets.length) return { sent: 0, removed: 0, skipped };

    const body = JSON.stringify(payload);
    const dead = [];
    let sent = 0;

    await Promise.all(
      targets.map(async (sub) => {
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
      this.subscriptions = all.filter((s) => !dead.includes(s.endpoint));
    }
    return { sent, removed: dead.length, skipped };
  }
}
