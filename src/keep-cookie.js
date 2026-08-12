/**
 * Cookie de sesion persistente, sin estado en el servidor.
 *
 * El problema: en el plan gratis de Render no hay disco, asi que el JSON con
 * las sesiones desaparece en cada reinicio y el movil vuelve a pedir la
 * contrasena. La sesion de `express-session` sigue existiendo y es la que
 * manda mientras el proceso viva; esto es solo el salvavidas que la vuelve a
 * levantar cuando el almacen se ha perdido.
 *
 * El testigo va firmado con HMAC-SHA256, la misma primitiva que ya usa
 * `express-session` para firmar el identificador de sesion, asi que la
 * resistencia a falsificacion no cambia respecto a lo que ya habia.
 *
 * Lo que si se pierde es la revocacion individual: sin registro en el servidor
 * no hay nada que borrar, y "Salir" solo puede pedirle al navegador que tire
 * la cookie. Se compensa con dos cosas:
 *
 *   1. Caducidad de 30 dias en vez de años, para que un testigo robado se
 *      muera solo.
 *   2. La clave de firma se deriva de SESSION_SECRET *y* de la contrasena del
 *      dashboard. Cambiar la contrasena invalida de golpe todos los testigos
 *      emitidos: es el boton de panico.
 *
 * Dentro del testigo no va nada secreto —esta firmado, no cifrado— solo la
 * fecha de caducidad.
 */

import crypto from 'node:crypto';

export const KEEP_COOKIE = 'bambu.keep';

/** 30 dias. Con `rolling` de facto, quien entra una vez al mes no la ve nunca. */
export const KEEP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Se reemite cuando le queda menos de esto, para no reescribirla en cada peticion. */
const REFRESH_UNDER_MS = 25 * 24 * 60 * 60 * 1000;

/** Etiqueta de version en la firma: subirla invalida los testigos antiguos. */
const LABEL = 'bambu-keep-v1';

export class KeepCookie {
  /**
   * @param {object} opts
   * @param {string} opts.secret   SESSION_SECRET (estable entre reinicios)
   * @param {string} opts.password contrasena del dashboard; al cambiarla, todo caduca
   * @param {boolean} opts.secure  marcar la cookie como Secure (HTTPS)
   * @param {number} [opts.maxAgeMs]
   */
  constructor({ secret, password, secure, maxAgeMs = KEEP_MAX_AGE_MS }) {
    this.key = crypto.createHmac('sha256', String(secret))
      .update(`${LABEL}|${String(password)}`)
      .digest();
    this.secure = Boolean(secure);
    this.maxAgeMs = maxAgeMs;
  }

  _sign(exp) {
    return crypto.createHmac('sha256', this.key)
      .update(`${LABEL}|${exp}`)
      .digest('base64url');
  }

  /** Emite (o renueva) la cookie en la respuesta. */
  issue(res) {
    const exp = Date.now() + this.maxAgeMs;
    res.cookie(KEEP_COOKIE, `${exp}.${this._sign(exp)}`, {
      maxAge: this.maxAgeMs,
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      path: '/',
    });
  }

  clear(res) {
    res.clearCookie(KEEP_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.secure, path: '/' });
  }

  /**
   * @returns {{exp:number}|null} el testigo si es valido y no ha caducado
   */
  verify(req) {
    const raw = readCookie(req, KEEP_COOKIE);
    if (!raw) return null;

    const cut = raw.indexOf('.');
    if (cut <= 0) return null;
    const exp = Number(raw.slice(0, cut));
    const sig = raw.slice(cut + 1);
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;

    // El propio testigo dice cuanto dura, asi que un cliente podria pedir una
    // caducidad absurda: se rechaza cualquiera que pase del maximo permitido.
    if (exp - Date.now() > this.maxAgeMs + 60_000) return null;

    const expected = Buffer.from(this._sign(exp));
    const given = Buffer.from(String(sig));
    if (given.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(given, expected)) return null;

    return { exp };
  }

  /** True si conviene reemitirla porque le queda poco. */
  needsRefresh(token) {
    return token.exp - Date.now() < REFRESH_UNDER_MS;
  }
}

/**
 * Lee una cookie de la cabecera. Se hace a mano para no meter `cookie-parser`
 * solo por esto: `res.cookie` ya viene con Express, y de leer solo hace falta
 * esta.
 */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
