/**
 * Freno de fuerza bruta para las puertas con contrasena.
 *
 * El dashboard esta publicado en internet y `/api/login` aceptaba intentos sin
 * limite: con una contrasena corta, un script la saca en minutos. Esto no
 * pretende ser un WAF, solo hacer que probar contrasenas cueste tiempo real.
 *
 * Los primeros fallos salen gratis —uno se equivoca al teclear en el movil— y
 * a partir de ahi cada fallo duplica la espera hasta un tope. Un acierto borra
 * el contador.
 *
 * Vive en memoria a proposito: persistirlo en el JSON de estado significaria
 * escribir en disco en cada intento fallido, que es justo lo que un atacante
 * querria provocar. Reiniciar el proceso lo vacia, pero el reinicio no lo
 * decide quien ataca.
 */

/** Fallos que no penalizan. El siguiente ya espera. */
const FREE_ATTEMPTS = 5;
/** Espera tras el primer fallo penalizado; se duplica en cada uno. */
const BASE_DELAY_MS = 2_000;
/** Tope de la espera: mas que esto no aporta y complica recuperarse. */
const MAX_DELAY_MS = 15 * 60_000;
/** Sin intentos durante este tiempo, la IP vuelve a empezar de cero. */
const IDLE_RESET_MS = 60 * 60_000;
/** Tope de IPs vigiladas, para que la tabla no crezca sin fin. */
const MAX_ENTRIES = 5_000;

export class LoginGuard {
  constructor(opts = {}) {
    this.freeAttempts = opts.freeAttempts ?? FREE_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? MAX_DELAY_MS;
    this.idleResetMs = opts.idleResetMs ?? IDLE_RESET_MS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    /** @type {Map<string,{fails:number,until:number,seen:number}>} */
    this.entries = new Map();
  }

  /**
   * @param {string} key normalmente la IP del cliente
   * @returns {{ok:true}|{ok:false,retryAfterMs:number}}
   */
  check(key) {
    const e = this.entries.get(key);
    if (!e) return { ok: true };
    const now = Date.now();
    if (now - e.seen > this.idleResetMs) {
      this.entries.delete(key);
      return { ok: true };
    }
    if (e.until > now) return { ok: false, retryAfterMs: e.until - now };
    return { ok: true };
  }

  /** Un intento fallido: sube el contador y calcula la proxima espera. */
  fail(key) {
    const now = Date.now();
    let e = this.entries.get(key);
    if (!e || now - e.seen > this.idleResetMs) e = { fails: 0, until: 0, seen: now };

    e.fails += 1;
    e.seen = now;
    const over = e.fails - this.freeAttempts;
    e.until = over > 0
      ? now + Math.min(this.baseDelayMs * 2 ** (over - 1), this.maxDelayMs)
      : 0;

    this.entries.set(key, e);
    if (this.entries.size > this.maxEntries) this._prune();
    return e.until > now ? e.until - now : 0;
  }

  /** Acierto: la IP deja de estar vigilada. */
  reset(key) {
    this.entries.delete(key);
  }

  _prune() {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (now - e.seen > this.idleResetMs) this.entries.delete(k);
    }
    // Si aun sobra sitio por ocupar, caen las mas antiguas. El Map itera en
    // orden de insercion, asi que las primeras son las mas viejas.
    if (this.entries.size <= this.maxEntries) return;
    const excess = this.entries.size - this.maxEntries;
    let i = 0;
    for (const k of this.entries.keys()) {
      if (i++ >= excess) break;
      this.entries.delete(k);
    }
  }
}

/**
 * Envuelve un manejador de Express con el freno.
 *
 * El manejador decide el resultado; este envoltorio solo mira el codigo de
 * estado: 401/403 cuenta como fallo, el resto como acierto.
 *
 * `scope` separa contadores: equivocarse con el codigo del panel no tiene por
 * que dejarte fuera del dashboard entero.
 */
export function guarded(guard, scope, handler) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocido';
    const key = `${scope}|${ip}`;
    const state = guard.check(key);
    if (!state.ok) {
      const secs = Math.ceil(state.retryAfterMs / 1000);
      res.set('Retry-After', String(secs));
      return res.status(429).json({
        error: `Demasiados intentos. Espera ${formatWait(secs)}.`,
        retryAfter: secs,
      });
    }

    // El resultado no se conoce hasta que el manejador responde, asi que el
    // recuento se engancha al final de la respuesta.
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 403) guard.fail(key);
      else if (res.statusCode < 400) guard.reset(key);
    });
    return handler(req, res, next);
  };
}

function formatWait(secs) {
  if (secs < 60) return `${secs} s`;
  return `${Math.ceil(secs / 60)} min`;
}
