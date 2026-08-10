/**
 * Detector de eventos + envio de notificaciones.
 *
 * Compara el estado normalizado nuevo contra el anterior y emite eventos
 * solo en las transiciones que importan. Evita el spam tipico de
 * "notificar en cada mensaje MQTT".
 */

import { EventEmitter } from 'node:events';

const SEVERITY = { 1: 'fatal', 2: 'grave', 3: 'aviso', 4: 'info' };

export class Notifier extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.telegramToken]
   * @param {string} [opts.telegramChatId]
   * @param {string} [opts.discordWebhook]
   * @param {string} [opts.genericWebhook] POST JSON a una URL cualquiera
   * @param {number} [opts.progressStep] notificar cada N% (0 = desactivado)
   */
  constructor(opts = {}) {
    super();
    this.telegramToken = opts.telegramToken || null;
    this.telegramChatId = opts.telegramChatId || null;
    this.discordWebhook = opts.discordWebhook || null;
    this.genericWebhook = opts.genericWebhook || null;
    this.progressStep = Number(opts.progressStep ?? 0);

    this.prev = null;
    this.seenHms = new Set();
    this.lastProgressBucket = -1;
    /** Historial en memoria para mostrarlo en el dashboard. */
    this.history = [];
  }

  get enabled() {
    return Boolean(this.telegramToken || this.discordWebhook || this.genericWebhook);
  }

  /** Procesa un estado normalizado y dispara lo que corresponda. */
  update(next, printerName = 'Bambu Lab A1') {
    const prev = this.prev;
    this.prev = next;
    if (!next) return;

    const job = next.jobName || 'trabajo sin nombre';

    // --- Transiciones de estado ---
    if (prev && prev.state !== next.state) {
      if (next.state === 'FINISH') {
        this._fire('finished', `✅ Impresion terminada: ${job}`, {
          printerName,
          job,
          level: 'success',
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'FAILED') {
        this._fire('failed', `❌ Impresion fallida: ${job}`, {
          printerName,
          job,
          level: 'error',
        });
        this.lastProgressBucket = -1;
      } else if (next.state === 'PAUSE') {
        const reason = next.stage ? ` (${next.stage})` : '';
        this._fire('paused', `⏸️ Impresion en pausa${reason}: ${job}`, {
          printerName,
          job,
          level: 'warning',
        });
      } else if (next.state === 'RUNNING' && prev.state === 'PAUSE') {
        this._fire('resumed', `▶️ Impresion reanudada: ${job}`, {
          printerName,
          job,
          level: 'info',
        });
      } else if (next.state === 'RUNNING' && prev.state !== 'RUNNING') {
        this._fire('started', `🖨️ Impresion iniciada: ${job}`, {
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
        this._fire('attention', `⚠️ La impresora necesita atencion: ${next.stage}`, {
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
      this._fire('hms', `🔧 Error HMS ${h.id} (severidad: ${sev})`, {
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
        this._fire(
          'progress',
          `📊 ${next.percent}% — ${job}${next.remainingText ? ` · quedan ${next.remainingText}` : ''}`,
          { printerName, job, level: 'info', silent: true },
        );
      }
    }
  }

  _fire(type, text, meta = {}) {
    const event = { type, text, at: Date.now(), ...meta };
    this.history.unshift(event);
    if (this.history.length > 100) this.history.pop();
    this.emit('notification', event);
    this.send(text, meta).catch((err) => this.emit('error', err));
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

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.emit('error', r.reason);
    }
  }
}
