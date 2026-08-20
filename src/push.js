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

  // El modelo convierte una lista de tres "Chrome · Android" identicos en algo
  // con lo que se puede trabajar: sin el no hay forma de saber cual de ellos es
  // el que no recibe los avisos.
  //
  // Chrome moderno recorta el user-agent por privacidad y deja "Android 10; K"
  // para todos los telefonos del mundo, asi que el modelo real llega por otra
  // via: el cliente lo pide con navigator.userAgentData y lo manda en `hints`.
  // Lo del user-agent queda de respaldo para los que aun no recortan.
  const fromUa = s.match(/Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\)/i)?.[1]?.trim();
  const model = hints.model || (fromUa && !/^(K|wv)$/i.test(fromUa) ? fromUa : null);
  const where = model && model.length <= 28 ? model : os;

  const label = `${browser} · ${where}`;
  // "App instalada" frente a "pestana del navegador" es justo lo que explica
  // por que en un iPhone llegan los avisos y en el de al lado no.
  return hints.standalone ? `${label} (app instalada)` : label;
}

/**
 * Margen antes de dar por perdido un aviso.
 *
 * El acuse lo manda el Service Worker nada mas pintar la notificacion, asi que
 * en condiciones normales llega en segundos. Pero el push service (FCM) SI
 * encola para un movil sin cobertura y lo entrega al reconectar, y eso puede
 * tardar. Diez minutos separan "aun puede llegar" de "aqui pasa algo".
 */
const ACK_GRACE_MS = 10 * 60_000;

/**
 * Que sabemos de la entrega en este dispositivo.
 *
 * Existe porque el resultado del envio NO dice nada: el push service responde
 * 201 en cuanto acepta el mensaje, tanto si el movil lo pinta como si su
 * fabricante lo tira a la basura. Es exactamente lo que pasa en los Xiaomi /
 * Redmi con la app cerrada, y sin esto es invisible: el panel decia "enviado a
 * 2 dispositivos" mientras uno de los dos llevaba semanas mudo.
 *
 *   'unknown'   nunca se le ha enviado nada todavia
 *   'ok'        el ultimo envio volvio confirmado
 *   'pending'   enviado hace poco, aun sin confirmar (normal unos segundos)
 *   'silent'    enviado hace rato y sin confirmar: el aviso no se esta viendo
 *
 * @param {object} sub
 * @param {number} [now]
 */
export function deliveryState(sub, now = Date.now()) {
  const sent = sub.lastSendAt || 0;
  const ack = sub.lastAckAt || 0;
  if (!sent) return 'unknown';
  // Con un margen de un minuto: el acuse del envio anterior puede cruzarse con
  // el envio siguiente y llegar un instante despues.
  if (ack >= sent - 60_000) return 'ok';
  return now - sent > ACK_GRACE_MS ? 'silent' : 'pending';
}

/**
 * Fabricante del aparato, a partir del user-agent.
 *
 * No es cosmetico: los avisos que no llegan con la app cerrada casi nunca son
 * culpa del navegador, sino de la capa de ahorro de bateria del fabricante, y
 * cada uno la esconde en un sitio distinto. Saber que es un Redmi permite dar
 * la ruta exacta de sus ajustes en vez de un "mira el ahorro de bateria".
 *
 * La marca sale del modelo ("Redmi Note 12") cuando el cliente ha podido
 * averiguarlo, y del user-agent si no. Cuando no hay ninguno de los dos se cae
 * a 'android' y se dan los pasos genericos, que es lo honesto.
 */
export function detectVendor(ua = '', model = '') {
  // El modelo va delante: con el user-agent recortado de Chrome moderno es lo
  // unico que queda para distinguir un Redmi de un Pixel.
  const s = `${model} ${ua}`;
  if (/iphone|ipad|ipod/i.test(s)) return 'ios';
  if (!/android/i.test(`${ua}`) && !model) return null;
  if (/xiaomi|redmi|poco|miui|hyperos|\bmi \d/i.test(s)) return 'xiaomi';
  if (/samsung|sm-[a-z]\d/i.test(s)) return 'samsung';
  if (/huawei|honor|\bhry-|\bana-/i.test(s)) return 'huawei';
  if (/oneplus|\bkb2|\ble2\d/i.test(s)) return 'oneplus';
  if (/realme|\brmx\d/i.test(s)) return 'realme';
  if (/\boppo|\bcph\d/i.test(s)) return 'oppo';
  if (/\bvivo\b|\bv2\d{3}/i.test(s)) return 'vivo';
  if (/motorola|\bmoto /i.test(s)) return 'motorola';
  return 'android';
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

  /**
   * Guarda sin forzar la escritura a disco.
   *
   * Para las marcas de envio y de acuse: pasan en cada aviso y por cada
   * dispositivo, y no valen un fsync. Si un reinicio se lleva la ultima, lo
   * unico que se pierde es un dato de diagnostico.
   */
  _touch(list) {
    this.store?.set('pushSubs', list);
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
        vendor: s.vendor || detectVendor(s.ua, s.model),
        // Las dos mitades de la unica pregunta que importa: se lo mandamos, y
        // llego? Ver `deliveryState`.
        lastSendAt: s.lastSendAt || null,
        lastAckAt: s.lastAckAt || null,
        delivery: deliveryState(s),
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

    // Lo que ya supieramos de este aparato no se pierde porque una renovacion
    // llegue sin ello: el `pushsubscriptionchange` del Service Worker reenvia
    // la suscripcion sin `info`, y ahi el modelo no viaja.
    const ua = info.ua || prev?.ua || '';
    const model = info.model || prev?.model || '';
    const standalone = info.standalone ?? prev?.standalone ?? false;

    const entry = {
      id: prev?.id || deviceId(sub.endpoint),
      endpoint: sub.endpoint,
      keys: sub.keys,
      at: prev?.at || Date.now(),
      lastSeen: Date.now(),
      enabled: prev ? prev.enabled !== false : true,
      // Las marcas de entrega son del aparato, no de la suscripcion: renovarla
      // no puede borrar que lleva tres semanas sin confirmar un aviso.
      lastSendAt: prev?.lastSendAt || null,
      lastAckAt: prev?.lastAckAt || null,
      ua,
      model,
      standalone,
      vendor: detectVendor(ua, model),
      label: describeDevice(ua, { standalone, model }),
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

    const dead = [];
    const delivered = [];
    let sent = 0;
    const now = Date.now();

    await Promise.all(
      targets.map(async (sub) => {
        try {
          // El cuerpo se compone por dispositivo para meterle su `d`: es lo
          // que permite al Service Worker acusar recibo diciendo QUIEN lo ha
          // recibido, sin conocer su propio endpoint.
          const body = JSON.stringify({ ...payload, d: sub.id });
          await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
          delivered.push(sub.id);
          sent += 1;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
          else console.error('[push]', err.statusCode || '', err.message);
        }
      }),
    );

    // "Aceptado por el push service", no "visto en el movil". Lo segundo lo
    // dice el acuse, y la diferencia entre los dos es justo el problema que
    // esto sirve para detectar.
    for (const s of all) if (delivered.includes(s.id)) s.lastSendAt = now;

    if (dead.length) {
      // Aqui si toca escritura firme: se esta borrando una suscripcion.
      this.subscriptions = all.filter((s) => !dead.includes(s.endpoint));
    } else if (delivered.length) {
      this._touch(all);
    }
    return { sent, removed: dead.length, skipped };
  }

  /**
   * Acuse de recibo: el Service Worker acaba de pintar un aviso.
   *
   * Es el unico dato honesto sobre si los avisos llegan de verdad a un
   * dispositivo. Sin autenticacion a proposito (ver la ruta en server.js): el
   * peor uso posible es marcar como sano un movil que lo esta.
   */
  ack(id) {
    const list = this.subscriptions;
    const target = list.find((s) => s.id === id);
    if (!target) return { ok: false, error: 'Dispositivo no encontrado' };
    target.lastAckAt = Date.now();
    this._touch(list);
    return { ok: true, id };
  }
}
