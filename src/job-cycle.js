/**
 * Ciclo de vida de una impresion, mas alla de lo que reporta la impresora.
 *
 * La A1 pasa de RUNNING a FINISH y ahi se queda: para ella el trabajo ha
 * acabado. Pero para quien esta al otro lado quedan dos etapas mas antes de
 * poder tocar la pieza, y son las que el dashboard necesita representar:
 *
 *   printing  ->  cooling (15 min)  ->  ready  ->  (retirada) idle
 *
 * El paso a `ready` lo dispara un temporizador, no un mensaje MQTT: la
 * impresora no vuelve a hablar despues de terminar, asi que si esperasemos a
 * un report el aviso de "ya puedes retirarla" no llegaria nunca.
 */

import { EventEmitter } from 'node:events';

export const PHASES = ['idle', 'printing', 'cooling', 'ready'];

/** Estados de gcode que significan "hay un trabajo vivo". */
const LIVE_STATES = new Set(['RUNNING', 'PREPARE', 'PAUSE', 'SLICING']);

export class JobCycle extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.coolMs] duracion del enfriamiento
   * @param {import('./store.js').Store} [opts.store]
   */
  constructor(opts = {}) {
    super();
    this.coolMs = Number(opts.coolMs) || 15 * 60_000;
    this.store = opts.store || null;

    const saved = this.store?.get('cycle') || {};
    this.phase = PHASES.includes(saved.phase) ? saved.phase : 'idle';
    this.finishedAt = saved.finishedAt || null;
    this.jobName = saved.jobName || null;
    this.outcome = saved.outcome || null; // 'FINISH' | 'FAILED'
    // La impresora se queda clavada en FINISH hasta el siguiente trabajo, asi
    // que sin esta marca el primer report posterior a "ya la he retirado"
    // volveria a abrir la fase `ready` y el aviso reaparecia solo. Se persiste
    // porque un reinicio tambien reabriria la fase de la pieza ya recogida.
    this.collected = Boolean(saved.collected);

    this._timer = null;
    this._lastState = null;

    // Si el proceso se cayo durante el enfriamiento, retomamos donde estaba.
    if (this.phase === 'cooling') this._armTimer({ silent: this.coolingRemainingMs() <= 0 });
  }

  // -------------------------------------------------------------------------
  // Consultas
  // -------------------------------------------------------------------------

  get coolEndsAt() {
    return this.finishedAt ? this.finishedAt + this.coolMs : null;
  }

  coolingRemainingMs() {
    if (!this.coolEndsAt) return 0;
    return Math.max(0, this.coolEndsAt - Date.now());
  }

  /** 0-100. Lo consume el anillo del panel de estado durante el enfriamiento. */
  coolingPercent() {
    if (!this.finishedAt) return 0;
    const done = (Date.now() - this.finishedAt) / this.coolMs;
    return Math.max(0, Math.min(100, Math.round(done * 100)));
  }

  /** Lo que se manda al navegador en cada snapshot. */
  toJSON() {
    return {
      phase: this.phase,
      finishedAt: this.finishedAt,
      coolEndsAt: this.coolEndsAt,
      coolMs: this.coolMs,
      coolingRemainingMs: this.coolingRemainingMs(),
      coolingPercent: this.coolingPercent(),
      jobName: this.jobName,
      outcome: this.outcome,
    };
  }

  // -------------------------------------------------------------------------
  // Transiciones
  // -------------------------------------------------------------------------

  /**
   * Alimenta la maquina con un estado normalizado.
   *
   * @param {object} norm
   * @param {boolean} [firstEver] primer estado tras arrancar el proceso: una
   *   impresion ya terminada antes de encender el servidor no debe generar
   *   avisos retroactivos.
   */
  update(norm, firstEver = false) {
    if (!norm) return;
    const prev = this._lastState;
    this._lastState = norm.state;

    if (LIVE_STATES.has(norm.state)) {
      this.jobName = norm.jobName || this.jobName;
      // Hay trabajo vivo otra vez: lo recogido era la pieza anterior.
      this.collected = false;
      if (this.phase !== 'printing') this._to('printing', { silent: firstEver });
      else this._persist();
      return;
    }

    const ended = norm.state === 'FINISH' || norm.state === 'FAILED';

    // Solo abrimos enfriamiento en la transicion real "estaba imprimiendo ->
    // ha terminado". Un FINISH que ya estaba ahi al conectar es historia.
    if (ended && LIVE_STATES.has(prev) && this.phase === 'printing') {
      this.jobName = norm.jobName || this.jobName;
      this.outcome = norm.state;
      this.finishedAt = Date.now();
      this._to('cooling');
      this._armTimer();
      return;
    }

    if (ended && this.phase === 'idle' && !this.collected) {
      // Arrancamos con la impresora ya en FINISH: la pieza lleva ahi un rato,
      // damos por hecho que esta fria y no notificamos nada.
      this.jobName = norm.jobName || this.jobName;
      this.outcome = norm.state;
      this._to('ready', { silent: true });
      return;
    }

    if (norm.state === 'IDLE' && (this.phase === 'printing' || this.phase === 'cooling')) {
      // La impresora se ha reiniciado o se ha cancelado el trabajo.
      this.clear();
    }
  }

  /**
   * Devuelve el ciclo a reposo.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.collected] lo confirma el usuario ("ya la he
   *   retirado"), no un cambio de estado de la impresora. Marca la pieza como
   *   recogida para que el FINISH que la maquina sigue reportando no vuelva a
   *   abrir la fase `ready`.
   */
  clear({ collected = false } = {}) {
    this._disarm();
    this.finishedAt = null;
    this.outcome = null;
    this.collected = collected;
    this._to('idle');
    // Si ya estabamos en idle, `_to` no persiste: la marca se guarda aqui.
    this._persist();
    this.store?.flush();
  }

  _to(phase, { silent = false } = {}) {
    if (this.phase === phase) return;
    this.phase = phase;
    this._persist();
    // Un cambio de fase se escribe ya, sin pasar por el agrupador del almacen:
    // el instante de entrar en enfriamiento es justo el que no puede perderse
    // si el proceso se reinicia (un redespliegue, por ejemplo) acto seguido.
    this.store?.flush();
    this.emit('phase', { ...this.toJSON(), silent });
  }

  _armTimer({ silent = false } = {}) {
    this._disarm();
    const wait = this.coolingRemainingMs();
    if (wait <= 0) {
      this._to('ready', { silent });
      return;
    }
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this.phase === 'cooling') this._to('ready');
    }, wait);
    this._timer.unref?.();
  }

  _disarm() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _persist() {
    this.store?.set('cycle', {
      phase: this.phase,
      finishedAt: this.finishedAt,
      jobName: this.jobName,
      outcome: this.outcome,
      collected: this.collected,
    });
  }
}
