/**
 * Ventana horaria de vigilia.
 *
 * EL PROBLEMA
 * -----------
 * En el plan gratuito de Render el servicio se duerme tras 15 min sin trafico
 * ENTRANTE, y dormido NO CORRE NADA: ni MQTT, ni temporizadores, ni el
 * auto-ping. De ahi sale el limite que conviene tener claro:
 *
 *   un proceso dormido no puede despertarse a si mismo, ni enterarse de que
 *   ha empezado una impresion.
 *
 * Asi que el auto-ping de src/server.js solo sabe sostener la vigilia una vez
 * el proceso ya esta en pie. Lo que decide este modulo es cuando merece la
 * pena sostenerla aunque no haya nada imprimiendo: durante las horas en las
 * que es plausible que alguien lance un trabajo, para que el arranque de esa
 * impresion se detecte al instante y no en el siguiente despertar.
 *
 * EL COSTE
 * --------
 * Render regala 750 horas de instancia al mes. La configuracion por defecto es
 * 0-24 (vigilia permanente): 24 h x 31 dias = 744 h, que caben en las 750 con
 * 6 h de margen. Ese margen es real pero fino, y depende de dos cosas:
 *
 *   - el cupo de 750 h es POR CUENTA, no por servicio: un segundo servicio
 *     free comiendo del mismo bote se lleva el margen por delante;
 *   - los redespliegues tambien consumen horas.
 *
 * Si algun mes se aprieta, una ventana de 9 a 23 son 14 h al dia (~434 h) y
 * deja sitio de sobra; las impresiones que caigan fuera de la ventana se
 * sostienen solas de todas formas.
 *
 * La cuenta la hace `estimateMonthlyHours()` y sale en /api/health, para poder
 * mirarla en vez de suponerla. Cuenta el mes PEOR (31 dias), que es el que
 * decide si te pasas del cupo.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Lee "9-23" (o "23-7", que cruza la medianoche) y lo deja en numeros.
 * Cadena vacia, "off" o "no" desactivan la ventana.
 *
 * @param {string} spec
 * @returns {{start:number, end:number}|null}
 */
export function parseWindow(spec) {
  const raw = String(spec ?? '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'no' || raw === 'false' || raw === '0') return null;

  const m = raw.match(/^(\d{1,2})\s*[-a:]\s*(\d{1,2})$/);
  if (!m) return null;

  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start > 23 || end < 0 || end > 24) return null;
  if (start === end) return null;

  return { start, end };
}

/**
 * Hora local (0-23) en la zona pedida.
 *
 * Se resuelve con Intl y no con getHours() porque el contenedor de Render
 * corre en UTC: sin esto, "de 9 a 23" serian las 9 de Londres en invierno y
 * las 10 en verano, justo el tipo de desfase que solo se nota el dia que el
 * aviso no llega.
 */
export function localHour(tz, now = new Date()) {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    // "24" en lugar de "00" a medianoche en algunas versiones de ICU.
    return Number(hour) % 24;
  } catch {
    return now.getHours();
  }
}

/**
 * @param {{start:number, end:number}|null} window
 * @param {string} tz
 * @param {Date} [now]
 */
export function insideWindow(window, tz, now = new Date()) {
  if (!window) return false;
  const h = localHour(tz, now);
  // Ventana que cruza la medianoche (23-7): dentro es "o al final del dia, o
  // al principio del siguiente".
  if (window.start < window.end) return h >= window.start && h < window.end;
  return h >= window.start || h < window.end;
}

/**
 * Horas de instancia al mes que implica la ventana, para el diagnostico.
 *
 * Se cuenta sobre 31 dias, no sobre la media de 30.4: la pregunta que responde
 * este numero es "me paso del cupo de 750 h", y ahi lo que manda es el mes mas
 * largo. Con 30.4 la vigilia 24/7 salia a 730 h y parecia tener 20 h de
 * margen; en un mes de 31 dias son 744 y el margen real es de 6.
 */
export function estimateMonthlyHours(window) {
  if (!window) return 0;
  const span =
    window.start < window.end
      ? window.end - window.start
      : 24 - window.start + window.end;
  return span * 31;
}

/** Milisegundos hasta el proximo comienzo de ventana. Solo para el log. */
export function msUntilWindow(window, tz, now = new Date()) {
  if (!window || insideWindow(window, tz, now)) return 0;
  const h = localHour(tz, now);
  const diff = (window.start - h + 24) % 24;
  return diff * HOUR_MS;
}
