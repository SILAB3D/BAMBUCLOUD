/**
 * Detector de eventos + envio de notificaciones.
 *
 * Compara el estado normalizado nuevo contra el anterior y emite eventos
 * solo en las transiciones que importan. Evita el spam tipico de
 * "notificar en cada mensaje MQTT".
 *
 * El historial se guarda en disco y se conserva 15 dias: el panel de actividad
 * del dashboard lo lee de ahi, asi que reiniciar el proceso ya no lo vacia.
 */

import { EventEmitter } from 'node:events';

import { lookupHms, lookupPrintError } from './error-codes.js';

export const HISTORY_DAYS = 15;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
// Tope duro ademas de la antiguedad: un bucle de errores HMS podria generar
// miles de entradas en un solo dia y reventar el fichero de estado.
const HISTORY_MAX = 600;

/**
 * Las dos categorias de avisos.
 *
 * `basic` es el minimo por el que uno tiene esto instalado: cuando la pieza se
 * esta enfriando, cuando ya se puede tocar, y cuando la maquina reporta un
 * error. Todo lo demas es seguimiento, util pero prescindible, y va en `other`.
 *
 * Cada categoria tiene su propio interruptor, que actua de llave maestra sobre
 * los avisos que contiene: apagar la categoria los calla todos sin perder que
 * tenia encendido cada uno, y volver a encenderla los devuelve como estaban.
 */
export const CATEGORIES = [
  {
    key: 'basic',
    label: 'Notificaciones básicas',
    desc: 'Enfriamiento, pieza lista y errores de la impresora.',
  },
  {
    key: 'other',
    label: 'Otras notificaciones',
    desc: 'Seguimiento del trabajo: inicio, fin, pausas y progreso.',
  },
];

/**
 * Catalogo de avisos que la app puede emitir.
 *
 * Es la unica fuente de verdad: el panel de administracion dibuja un
 * interruptor por entrada, agrupados por `category`, asi que anadir un tipo
 * aqui basta para que aparezca en la interfaz. `key` coincide con el `type`
 * que se pasa a fire().
 */
export const TRIGGERS = [
  {
    key: 'cooling',
    category: 'basic',
    label: 'La impresión se está enfriando',
    desc: 'Al terminar, cuando arranca el periodo de enfriamiento.',
  },
  {
    key: 'ready',
    category: 'basic',
    label: 'La impresión puede retirarse',
    desc: 'Cuando la cama ya se ha enfriado y la pieza se puede sacar.',
  },
  {
    key: 'hms',
    category: 'basic',
    label: 'Errores de la impresora (HMS)',
    desc: 'Traducidos del catálogo oficial de Bambu Lab, con qué hacer.',
  },
  {
    key: 'started',
    category: 'other',
    label: 'Impresión iniciada',
    desc: 'Al empezar un trabajo nuevo.',
  },
  {
    key: 'finished',
    category: 'other',
    label: 'Impresión terminada',
    desc: 'Cuando la impresora acaba el trabajo.',
  },
  {
    key: 'paused',
    category: 'other',
    label: 'Impresión en pausa',
    desc: 'Pausa manual, por AMS o por el usuario.',
  },
  {
    key: 'resumed',
    category: 'other',
    label: 'Impresión reanudada',
    desc: 'Al continuar tras una pausa.',
  },
  {
    key: 'failed',
    category: 'other',
    label: 'Impresión fallida',
    desc: 'Cuando el trabajo termina en error.',
  },
  {
    key: 'attention',
    category: 'other',
    label: 'La impresora necesita atención',
    desc: 'Cambio de filamento, atasco, filamento agotado…',
  },
  {
    key: 'progress',
    category: 'other',
    label: 'Hitos de progreso',
    desc: 'Avisos cada N % (solo si NOTIFY_PROGRESS_STEP no es 0).',
  },
];

/** type -> categoria, resuelto una vez. */
const CATEGORY_OF = new Map(TRIGGERS.map((t) => [t.key, t.category]));

/**
 * Todo llega apagado, a proposito, y ahora quien lo apaga son las categorias.
 *
 * En el plan gratuito de Render no hay disco: cada reinicio del servicio se
 * lleva por delante `bambu-state.json` y con el los ajustes, asi que lo que
 * este aqui es lo que habra tras cada redespliegue o cada vez que el servicio
 * despierte de cero. Con las dos categorias apagadas, el silencio es el punto
 * de partida; al reves —arrancar con `cooling`/`ready` encendidos— cualquier
 * reinicio reactivaba solo unos avisos que quiza se habian apagado hace un
 * minuto.
 *
 * Los interruptores individuales SI arrancan encendidos: asi encender una
 * categoria enciende de verdad lo que promete, en vez de dejar al usuario
 * delante de una lista que sigue muda hasta que la recorre entera.
 *
 * Con un disco persistente montado (ver render.yaml) esto solo decide el
 * primer arranque; a partir de ahi manda lo guardado.
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  groups: Object.fromEntries(CATEGORIES.map((c) => [c.key, false])),
  triggers: Object.fromEntries(TRIGGERS.map((t) => [t.key, true])),
};

/**
 * Ajustes guardados antes de que existieran las categorias.
 *
 * No traen `groups`, y darles el valor de fabrica (apagado) dejaria mudo de
 * golpe un dashboard que estaba avisando. Se les dan las dos categorias
 * encendidas: los interruptores individuales que ya tenian guardados siguen
 * mandando exactamente igual que antes.
 */
const LEGACY_GROUPS = Object.fromEntries(CATEGORIES.map((c) => [c.key, true]));

export class Notifier extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.telegramToken]
   * @param {string} [opts.telegramChatId]
   * @param {string} [opts.discordWebhook]
   * @param {string} [opts.genericWebhook] POST JSON a una URL cualquiera
   * @param {number} [opts.progressStep] notificar cada N% (0 = desactivado)
   * @param {import('./store.js').Store} [opts.store]
   * @param {import('./push.js').PushHub} [opts.push]
   */
  constructor(opts = {}) {
    super();
    this.telegramToken = opts.telegramToken || null;
    this.telegramChatId = opts.telegramChatId || null;
    this.discordWebhook = opts.discordWebhook || null;
    this.genericWebhook = opts.genericWebhook || null;
    this.progressStep = Number(opts.progressStep ?? 0);
    this.store = opts.store || null;
    this.push = opts.push || null;

    this.prev = null;
    this.seenHms = new Set();
    this.lastProgressBucket = -1;

    this.history = this._prune(this.store?.get('history') || []);
  }

  get enabled() {
    return Boolean(this.telegramToken || this.discordWebhook || this.genericWebhook);
  }

  // -------------------------------------------------------------------------
  // Ajustes
  // -------------------------------------------------------------------------

  get settings() {
    const saved = this.store?.get('settings');
    if (!saved) return structuredClone(DEFAULT_SETTINGS);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      groups: { ...(saved.groups ? DEFAULT_SETTINGS.groups : LEGACY_GROUPS), ...(saved.groups || {}) },
      triggers: { ...DEFAULT_SETTINGS.triggers, ...(saved.triggers || {}) },
    };
  }

  /** Acepta parches parciales; devuelve los ajustes ya resueltos. */
  updateSettings(patch = {}) {
    const current = this.settings;
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      groups: { ...current.groups },
      triggers: { ...current.triggers },
    };
    for (const [key, value] of Object.entries(patch.groups || {})) {
      if (typeof value === 'boolean' && key in next.groups) next.groups[key] = value;
    }
    for (const [key, value] of Object.entries(patch.triggers || {})) {
      if (typeof value === 'boolean') next.triggers[key] = value;
    }
    this.store?.set('settings', next);
    // Sin pasar por el agrupador: esto es una accion deliberada del usuario y
    // no puede evaporarse porque el proceso se reinicie medio segundo despues.
    this.store?.flush();
    return next;
  }

  /**
   * Tres llaves en serie, de la mas general a la mas concreta: el interruptor
   * maestro, el de la categoria a la que pertenece el aviso, y el suyo propio.
   * Basta con que una este abierta... perdon, cerrada, para que no salga nada.
   *
   * Un tipo que no este en el catalogo (uno nuevo que aun no tenga ficha) pasa
   * la parte de categoria: mejor que avise de mas a que se pierda en silencio.
   */
  allows(type) {
    const s = this.settings;
    if (!s.enabled) return false;
    const category = CATEGORY_OF.get(type);
    if (category && s.groups[category] === false) return false;
    return s.triggers[type] !== false;
  }

  // -------------------------------------------------------------------------
  // Deteccion
  // -------------------------------------------------------------------------

  /** Procesa un estado normalizado y dispara lo que corresponda. */
  update(next, printerName = 'Bambu Lab A1') {
    const prev = this.prev;
    this.prev = next;
    if (!next) return;

    const job = next.jobName || 'trabajo sin nombre';

    // --- Transiciones de estado ---
    if (prev && prev.state !== next.state) {
      if (next.state === 'FINISH') {
        this.fire('finished', `✅ Impresión terminada: ${job}`, {
          printerName,
          job,
          level: 'success',
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'FAILED') {
        // La impresora suele decir POR QUE ha fallado en `print_error`, que es
        // un codigo del mismo catalogo oficial que los HMS. Sin traducirlo, el
        // aviso se queda en "ha fallado" y hay que ir a mirar a la maquina.
        const error = lookupPrintError(next.printError);
        this.fire('failed', `❌ Impresión fallida: ${job}`, {
          printerName,
          job,
          level: 'error',
          ...(error && {
            code: error.code,
            detail: error.description,
            remedy: error.remedy,
            url: error.url,
          }),
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'PAUSE') {
        const reason = next.stage ? ` (${next.stage})` : '';
        this.fire('paused', `⏸️ Impresión en pausa${reason}: ${job}`, {
          printerName,
          job,
          level: 'warning',
        });
      } else if (next.state === 'RUNNING' && prev.state === 'PAUSE') {
        this.fire('resumed', `▶️ Impresión reanudada: ${job}`, {
          printerName,
          job,
          level: 'info',
        });
      } else if (next.state === 'RUNNING' && prev.state !== 'RUNNING') {
        this.fire('started', `🖨️ Impresión iniciada: ${job}`, {
          printerName,
          job,
          level: 'info',
        });
        this.lastProgressBucket = -1;
      }
    }

    // --- Etapas que requieren atencion humana ---
    if (prev && prev.stageCode !== next.stageCode) {
      const needsUser = [22, 23, 24, 25, 29, 31, 32];
      if (needsUser.includes(next.stageCode)) {
        this.fire('attention', `⚠️ La impresora necesita atención: ${next.stage}`, {
          printerName,
          job,
          level: 'warning',
        });
      }
    }

    // --- Errores HMS nuevos ---
    //
    // El aviso lleva QUE pasa (texto oficial de Bambu) y QUE HACER, no el
    // codigo: "0700_2000_0002_0001" no le dice nada a nadie a las tres de la
    // madrugada. El codigo sigue viajando en `code` para el historial y para
    // el enlace a la ficha oficial.
    for (const h of next.hms || []) {
      if (this.seenHms.has(h.id)) continue;
      this.seenHms.add(h.id);
      const info = lookupHms(h.id, h.severity);
      const headline = info.known ? info.description : `Error ${info.id} (${info.severityLabel})`;
      this.fire('hms', `🔧 ${headline}`, {
        printerName,
        job,
        level: info.severity <= 2 ? 'error' : 'warning',
        code: info.id,
        severity: info.severity,
        severityLabel: info.severityLabel,
        remedy: info.remedy,
        url: info.url,
      });
    }
    // Limpiar los que ya se resolvieron
    const activeIds = new Set((next.hms || []).map((h) => h.id));
    for (const id of this.seenHms) {
      if (!activeIds.has(id)) this.seenHms.delete(id);
    }

    // --- Hitos de progreso ---
    // Solo a partir del segundo estado: al arrancar el servidor con una
    // impresion a medias no tiene sentido avisar del progreso actual.
    if (prev && this.progressStep > 0 && next.printing && next.percent != null) {
      const bucket = Math.floor(next.percent / this.progressStep);
      if (bucket > this.lastProgressBucket && next.percent > 0 && next.percent < 100) {
        this.lastProgressBucket = bucket;
        this.fire(
          'progress',
          `📊 ${next.percent}% — ${job}${next.remainingText ? ` · quedan ${next.remainingText}` : ''}`,
          { printerName, job, level: 'info', silent: true },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Emision
  // -------------------------------------------------------------------------

  /**
   * Registra el evento y lo reparte. El historial se escribe siempre (es el
   * registro de lo que ha pasado, no un canal de aviso), pero el envio a
   * Telegram, webhooks y Web Push respeta los interruptores del panel.
   */
  fire(type, text, meta = {}) {
    const allowed = this.allows(type);
    // `notify` viaja hasta el navegador: es lo que decide si ademas de entrar
    // en el historial el evento hace saltar un aviso en pantalla. Sin esto, un
    // tipo apagado desde el panel seguia avisando en las pestanas abiertas,
    // que es justo lo que el interruptor dice que no debe pasar.
    const event = { type, text, at: Date.now(), notify: allowed, ...meta };

    this.history.unshift(event);
    this.history = this._prune(this.history);
    this.store?.set('history', this.history);

    this.emit('notification', event);

    if (!allowed) return event;
    this.send(text, { ...meta, type }).catch((err) => this.emit('error', err));
    return event;
  }

  _prune(list) {
    const cutoff = Date.now() - HISTORY_MS;
    return list
      .filter((e) => e && typeof e.at === 'number' && e.at >= cutoff)
      .sort((a, b) => b.at - a.at)
      .slice(0, HISTORY_MAX);
  }

  /**
   * Un aviso traducido tiene tres partes y no todos los canales admiten las
   * tres: Telegram y Discord se llevan el texto entero (que hace, que hacer y
   * el enlace a la ficha), y el push del movil solo las dos primeras — el
   * enlace no se puede pulsar desde la notificacion, y ocupa dos lineas.
   */
  static compose(text, meta = {}, { withUrl = true } = {}) {
    const lines = [text];
    if (meta.detail && meta.detail !== text) lines.push(meta.detail);
    if (meta.remedy) lines.push(`👉 ${meta.remedy}`);
    if (withUrl && meta.url) lines.push(meta.url);
    return lines.join('\n');
  }

  async send(text, meta = {}) {
    const jobs = [];
    const full = Notifier.compose(text, meta);
    const short = Notifier.compose(text, meta, { withUrl: false });

    if (this.telegramToken && this.telegramChatId) {
      jobs.push(
        fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text: full,
            disable_notification: Boolean(meta.silent),
          }),
        }),
      );
    }

    if (this.discordWebhook) {
      jobs.push(
        fetch(this.discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: full }),
        }),
      );
    }

    if (this.genericWebhook) {
      jobs.push(
        fetch(this.genericWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...meta }),
        }),
      );
    }

    // Los hitos de progreso son ruido en el movil: van al historial y a los
    // canales de texto, pero no vibran el telefono.
    if (this.push?.enabled && !meta.silent) {
      jobs.push(
        this.push.send({
          title: meta.printerName || 'Bambu Lab',
          body: short,
          tag: meta.type || 'bambu',
          url: '/',
        }),
      );
    }

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.emit('error', r.reason);
    }
  }
}
