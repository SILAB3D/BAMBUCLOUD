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
 * Render regala 750 horas de instancia al mes. Una ventana de 9 a 23 son 14 h
 * al dia, ~420 h al mes: sobra margen para las impresiones que se salgan de la
 * ventana (esas mantienen el proceso despierto por su cuenta) y para los
 * despliegues. Estar despierto 24/7 serian ~730 h, que entra por los pelos y
 * sin ningun margen; de ahi que la ventana no sea 0-24.
 *
 * La cuenta la hace `estimateMonthlyHours()` y sale en /api/health, para poder
 * mirarla en vez de suponerla.
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

/** Horas de instancia al mes que implica la ventana, para el diagnostico. */
export function estimateMonthlyHours(window) {
  if (!window) return 0;
  const span =
    window.start < window.end
      ? window.end - window.start
      : 24 - window.start + window.end;
  return Math.round(span * 30.4);
}

/** Milisegundos hasta el proximo comienzo de ventana. Solo para el log. */
export function msUntilWindow(window, tz, now = new Date()) {
  if (!window || insideWindow(window, tz, now)) return 0;
  const h = localHour(tz, now);
  const diff = (window.start - h + 24) % 24;
  return diff * HOUR_MS;
}
