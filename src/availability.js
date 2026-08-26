/**
 * Disponibilidad del usuario ("estoy" / "no estoy").
 *
 * QUE PROBLEMA RESUELVE
 * ---------------------
 * Los interruptores del panel de administracion contestan a "de que quiero que
 * me avisen": son una decision de configuracion, se tocan una vez y se olvidan.
 * Esto contesta a otra pregunta distinta, que cambia varias veces al dia: "voy
 * a estar delante para hacer algo con el aviso, o esta sonando en una mesita a
 * las tres de la manana".
 *
 * Mezclarlas en el mismo sitio era el error: silenciar la noche apagando las
 * categorias del panel obliga a acordarse de volver a encenderlas, y el dia que
 * uno no se acuerda la impresion termina sin que nadie se entere. Por eso este
 * interruptor esta en la campana de la pantalla principal (a un toque, sin
 * codigo de administracion) y por eso VUELVE SOLO: cada dia a las 9:00 se pone
 * en "disponible" pase lo que pase.
 *
 * EL RELOJ NO SE PUEDE CONFIAR A UN TEMPORIZADOR
 * ---------------------------------------------
 * En el plan gratuito de Render el proceso se duerme, se reinicia y se
 * redespliega. Un setTimeout apuntando a las 9:00 no sobrevive a nada de eso.
 * Asi que el reset no se programa: se DEDUCE. Se guarda el ultimo dia (fecha
 * local, no marca de tiempo) en el que ya se hizo, y cada consulta comprueba si
 * hoy toca. Un proceso que arranca a las 11:00 aplica el reset de las 9:00 al
 * primer vistazo, que es justo lo que se quiere.
 *
 * La hora es local de verdad (Intl con la zona de WAKE_TZ): el contenedor corre
 * en UTC y "las 9" tienen que ser las 9 de Madrid tambien en verano.
 */

import { EventEmitter } from 'node:events';

/** Hora local a la que se vuelve a "estoy disponible" cada dia. */
export const RESET_HOUR = 9;

/**
 * Fecha local en la zona pedida, como "2026-08-26".
 *
 * En formato ISO a proposito: es lo que permite comparar dos dias con `!==` sin
 * pensar en husos ni en si el mes tiene 30 dias.
 */
export function localDay(tz, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Hora local (0-23) en la zona pedida.
 *
 * Duplica a proposito lo que hace `wake.localHour`: son dos relojes con dos
 * motivos distintos (uno decide cuando gastar horas de instancia, el otro
 * cuando devolver los avisos) y encadenarlos solo serviria para que tocar uno
 * rompiera el otro.
 */
export function localHour(tz, now = new Date()) {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    return Number(h) % 24;
  } catch {
    return now.getHours();
  }
}

export class Availability extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store.js').Store} [opts.store]
   * @param {string} [opts.tz] zona horaria en la que se cuentan las 9:00
   * @param {number} [opts.hour] hora del reset diario
   */
  constructor({ store = null, tz = 'Europe/Madrid', hour = RESET_HOUR } = {}) {
    super();
    this.store = store;
    this.tz = tz;
    this.hour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : RESET_HOUR;
  }

  /**
   * Aplica el reset diario si toca y devuelve el estado ya resuelto.
   *
   * Es el unico camino de lectura: cualquier sitio que pregunte por la
   * disponibilidad hace avanzar el reloj de paso, y asi no hace falta que un
   * temporizador sea puntual para que las 9:00 funcionen.
   */
  state(now = new Date()) {
    const saved = this.store?.get('availability') || null;
    const today = localDay(this.tz, now);
    const h = localHour(this.tz, now);

    let next = saved;
    let changed = false;

    if (!saved || typeof saved.available !== 'boolean') {
      // Primer arranque: disponible. Y el dia queda marcado solo si las 9 ya
      // han pasado; si no, el reset de hoy sigue pendiente (aunque no cambie
      // nada, porque ya estamos disponibles).
      next = { available: true, since: now.getTime(), day: h >= this.hour ? today : null };
    } else if (h >= this.hour && saved.day !== today) {
      // Aqui esta el reset. `day` se marca aunque ya estuvieramos disponibles:
      // lo que se apunta es "el de hoy ya esta hecho", no "hoy hubo cambio".
      changed = saved.available !== true;
      next = { available: true, since: changed ? now.getTime() : saved.since || now.getTime(), day: today };
    }

    if (next !== saved) {
      this.store?.set('availability', next);
      // Escritura firme: si un reinicio se lleva el "ya disponible" de hoy no
      // pasa nada, pero si se lleva un "no estoy" recien pulsado, el movil
      // vuelve a sonar a los dos minutos.
      this.store?.flush();
      if (changed) this.emit('change', this.toJSON(next));
    }

    return next;
  }

  /** @returns {boolean} si ahora mismo los avisos deben llegar al dispositivo. */
  get available() {
    return this.state().available;
  }

  /**
   * Cambio manual desde la campana. Devuelve el estado resuelto.
   * @param {boolean} available
   */
  set(available, now = new Date()) {
    const current = this.state(now);
    const value = Boolean(available);
    // El campo `day` significa "el reset de ese dia ya esta aplicado", no "el
    // dia en que se toco esto". La diferencia importa a las 2 de la manana:
    // marcar hoy ahi se comeria el reset de las 9:00 de HOY y el silencio
    // duraria 31 horas en vez de siete.
    const h = localHour(this.tz, now);
    const next = {
      available: value,
      since: current.available === value ? current.since : now.getTime(),
      day: h >= this.hour ? localDay(this.tz, now) : current.day || null,
    };
    this.store?.set('availability', next);
    this.store?.flush();
    const json = this.toJSON(next);
    if (current.available !== value) this.emit('change', json);
    return json;
  }

  /** Lo que viaja al navegador. */
  toJSON(raw = this.state()) {
    return {
      available: raw.available !== false,
      since: raw.since || null,
      resetHour: this.hour,
      tz: this.tz,
    };
  }
}
