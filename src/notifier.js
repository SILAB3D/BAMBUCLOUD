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

const SEVERITY = { 1: 'fatal', 2: 'grave', 3: 'aviso', 4: 'info' };

export const HISTORY_DAYS = 15;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
// Tope duro ademas de la antiguedad: un bucle de errores HMS podria generar
// miles de entradas en un solo dia y reventar el fichero de estado.
const HISTORY_MAX = 600;

/**
 * Catalogo de avisos que la app puede emitir.
 *
 * Es la unica fuente de verdad: el panel de administracion dibuja un
 * interruptor por entrada, asi que anadir un tipo aqui basta para que aparezca
 * en la interfaz. `key` coincide con el `type` que se pasa a fire().
 */
export const TRIGGERS = [
  { key: 'started', label: 'Impresión iniciada', desc: 'Al empezar un trabajo nuevo.' },
  { key: 'finished', label: 'Impresión terminada', desc: 'Cuando la impresora acaba el trabajo.' },
  {
    key: 'cooling',
    label: 'La impresión se está enfriando',
    desc: 'Al terminar, cuando arranca el periodo de enfriamiento.',
  },
  {
    key: 'ready',
    label: 'La impresión puede retirarse',
    desc: 'Cuando la cama ya se ha enfriado y la pieza se puede sacar.',
  },
  { key: 'paused', label: 'Impresión en pausa', desc: 'Pausa manual, por AMS o por el usuario.' },
  { key: 'resumed', label: 'Impresión reanudada', desc: 'Al continuar tras una pausa.' },
  { key: 'failed', label: 'Impresión fallida', desc: 'Cuando el trabajo termina en error.' },
  {
    key: 'attention',
    label: 'La impresora necesita atención',
    desc: 'Cambio de filamento, atasco, filamento agotado…',
  },
  { key: 'hms', label: 'Errores HMS', desc: 'Códigos de diagnóstico que reporta la máquina.' },
  {
    key: 'progress',
    label: 'Hitos de progreso',
    desc: 'Avisos cada N % (solo si NOTIFY_PROGRESS_STEP no es 0).',
  },
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  triggers: Object.fromEntries(TRIGGERS.map((t) => [t.key, true])),
};

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
    const saved = this.store?.get('settings') || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      triggers: { ...DEFAULT_SETTINGS.triggers, ...(saved.triggers || {}) },
    };
  }

  /** Acepta parches parciales; devuelve los ajustes ya resueltos. */
  updateSettings(patch = {}) {
    const current = this.settings;
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      triggers: { ...current.triggers },
    };
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
   * Un tipo sin interruptor propio (arranque, fallo, HMS...) solo depende del
   * interruptor maestro: los unicos con conmutador individual son los que se
   * exponen en el panel de administracion.
   */
  allows(type) {
    const s = this.settings;
    if (!s.enabled) return false;
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
        this.fire('failed', `❌ Impresión fallida: ${job}`, {
          printerName,
          job,
          level: 'error',
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
    for (const h of next.hms || []) {
      if (this.seenHms.has(h.id)) continue;
      this.seenHms.add(h.id);
      const sev = SEVERITY[h.severity] || 'desconocida';
      this.fire('hms', `🔧 Error HMS ${h.id} (severidad: ${sev})`, {
        printerName,
        job,
        level: h.severity <= 2 ? 'error' : 'warning',
        code: h.id,
        url: `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode?code=${h.id}`,
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
    const event = { type, text, at: Date.now(), ...meta };

    this.history.unshift(event);
    this.history = this._prune(this.history);
    this.store?.set('history', this.history);

    this.emit('notification', event);

    if (!this.allows(type)) return event;
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

  async send(text, meta = {}) {
    const jobs = [];

    if (this.telegramToken && this.telegramChatId) {
      jobs.push(
        fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text: meta.url ? `${text}\n${meta.url}` : text,
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
          body: JSON.stringify({ content: meta.url ? `${text}\n${meta.url}` : text }),
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
          body: text,
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
