/**
 * Porcentaje de impresion con una decimal.
 *
 * POR QUE HACE FALTA ESTO
 * -----------------------
 * La impresora publica `mc_percent` como ENTERO: 41, 42, 43... No existe un
 * campo con mas resolucion en el report MQTT, asi que la decima no se puede
 * "leer", hay que deducirla.
 *
 * COMO SE DEDUCE
 * --------------
 * Con el otro dato que si manda la maquina: `mc_remaining_time`. Estando en el
 * 42 % y quedando 58 minutos, cada punto porcentual dura ~1 min; a los 30 s de
 * entrar en el 42 vamos por el 42.5. La decima es, por tanto, una
 * interpolacion en el tiempo dentro del punto entero en curso, no una medida.
 *
 * Reglas que se respetan siempre, para que el numero no mienta:
 *
 *   - nunca baja (salvo trabajo nuevo, donde se reinicia)
 *   - nunca se sale del punto entero: 42 <= fino < 43, asi que redondear
 *     hacia abajo devuelve exactamente el `mc_percent` oficial
 *   - si no hay tiempo restante fiable, se queda en el entero con ".0"
 *
 * Vive fuera de normalize() porque normalize() es una funcion pura sobre un
 * unico report, y esto necesita recordar cuando empezo el punto actual.
 */

/** Nunca se llega a tocar el siguiente entero: 42.9 es el techo del 42. */
const MAX_FRACTION = 0.9;

// Cotas de cordura para la duracion estimada de un punto porcentual. Sin
// ellas, un `mc_remaining_time` disparatado (los hay al empezar, mientras la
// estimacion se asienta) congelaria la decima o la dispararia al techo.
const MIN_MS_PER_POINT = 15_000;
const MAX_MS_PER_POINT = 30 * 60_000;

export class FineProgress {
  constructor() {
    this._percent = null; // ultimo entero visto
    this._since = 0; // cuando aparecio ese entero
    this._msPerPoint = null; // lo que dura un punto, estimado al entrar en el
    this._key = null; // trabajo al que pertenece todo lo anterior
    this._last = null; // ultimo valor devuelto (para no retroceder)
  }

  reset() {
    this._percent = null;
    this._since = 0;
    this._msPerPoint = null;
    this._key = null;
    this._last = null;
  }

  /**
   * @param {object|null} norm estado normalizado
   * @param {number} [now]
   * @returns {number|null} porcentaje con una decimal, o null si no hay dato
   */
  update(norm, now = Date.now()) {
    if (!norm || norm.percent == null) {
      this.reset();
      return null;
    }

    const percent = Math.max(0, Math.min(100, Math.floor(norm.percent)));
    // Identidad del trabajo: si cambia, todo lo acumulado es de otra pieza.
    const key = norm.taskId || norm.jobName || null;

    if (key !== this._key || this._percent == null || percent < this._percent) {
      this._key = key;
      this._percent = percent;
      this._since = now;
      this._msPerPoint = this._estimate(norm, percent);
      this._last = percent;
      return percent;
    }

    if (percent > this._percent) {
      this._percent = percent;
      this._since = now;
      this._msPerPoint = this._estimate(norm, percent);
    }

    // El 100 no se interpola: no hay un 100.4 que tenga sentido.
    if (percent >= 100) {
      this._last = 100;
      return 100;
    }

    // Pausada o terminada: el reloj de la impresion no corre, la decima
    // tampoco. Se congela en lo ultimo mostrado en vez de seguir subiendo.
    if (!norm.printing) return this._last ?? percent;

    let value = percent;
    if (this._msPerPoint) {
      const elapsed = Math.max(0, now - this._since);
      value = percent + Math.min(MAX_FRACTION, elapsed / this._msPerPoint);
    }

    const rounded = Math.round(value * 10) / 10;
    // Monotonia: entre dos reports el tiempo solo avanza, pero una estimacion
    // nueva puede recortar el paso. Que el numero baje seria peor que que se
    // quede quieto un rato.
    const out = this._last != null && rounded < this._last ? this._last : rounded;
    this._last = out;
    return out;
  }

  /** Cuanto dura un punto porcentual, segun el tiempo que la maquina dice que queda. */
  _estimate(norm, percent) {
    const left = norm.remainingMinutes;
    if (left == null || left <= 0 || percent >= 100) return null;
    const ms = (left * 60_000) / (100 - percent);
    if (!Number.isFinite(ms)) return null;
    return Math.min(MAX_MS_PER_POINT, Math.max(MIN_MS_PER_POINT, ms));
  }
}
