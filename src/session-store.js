/**
 * Almacen de sesiones en disco para express-session.
 *
 * El almacen por defecto (`MemoryStore`) vive en RAM: cada reinicio del
 * proceso —un redespliegue, un `docker compose up -d`, el VPS reiniciandose de
 * madrugada— tiraba todas las sesiones y el movil volvia a pedir la password.
 * Lo unico que se quiere aqui es lo contrario: entrar una vez y no volver a
 * ver la pantalla de acceso hasta pulsar "Salir del dashboard".
 *
 * Se apoya en el mismo `Store` JSON que el resto del estado, asi que no hace
 * falta ni una dependencia mas ni un segundo fichero que montar en el volumen.
 */

import session from 'express-session';

const KEY = 'sessions';
// `rolling` hace que cada peticion refresque la caducidad de la cookie, lo que
// aqui significaria reescribir el JSON entero varias veces por minuto. La
// sesion solo se vuelve a guardar cuando su vencimiento se ha movido mas de
// esto; con caducidades de años, perder unas horas de precision da igual.
const TOUCH_MS = 6 * 60 * 60_000;

export class JsonSessionStore extends session.Store {
  /**
   * @param {import('./store.js').Store} store almacen JSON compartido
   */
  constructor(store) {
    super();
    this.store = store;
    this.sessions = this._load();
  }

  _load() {
    const raw = this.store.get(KEY);
    if (!raw || typeof raw !== 'object') return {};
    // Las caducadas no se arrastran: si no, el JSON crece sin fin con las
    // sesiones de cada navegador que ha pasado por aqui.
    const now = Date.now();
    const live = {};
    for (const [sid, entry] of Object.entries(raw)) {
      if (entry?.expires && entry.expires > now) live[sid] = entry;
    }
    return live;
  }

  _save() {
    this.store.set(KEY, this.sessions);
  }

  /** Vencimiento absoluto de una sesion, en ms. */
  _expiry(sess) {
    const at = sess?.cookie?.expires;
    if (at) return new Date(at).getTime();
    const maxAge = Number(sess?.cookie?.originalMaxAge);
    return Date.now() + (Number.isFinite(maxAge) ? maxAge : 24 * 60 * 60_000);
  }

  get(sid, cb) {
    const entry = this.sessions[sid];
    if (!entry) return cb(null, null);
    if (entry.expires && entry.expires <= Date.now()) {
      delete this.sessions[sid];
      this._save();
      return cb(null, null);
    }
    let data = null;
    try {
      data = JSON.parse(entry.data);
    } catch {
      // Entrada corrupta: mejor pedir login que reventar cada peticion.
      delete this.sessions[sid];
      this._save();
    }
    cb(null, data);
  }

  set(sid, sess, cb) {
    this.sessions[sid] = { expires: this._expiry(sess), data: JSON.stringify(sess) };
    this._save();
    // Un login tiene que sobrevivir aunque el proceso muera acto seguido.
    this.store.flush();
    cb?.(null);
  }

  touch(sid, sess, cb) {
    const entry = this.sessions[sid];
    if (!entry) return cb?.(null);
    const expires = this._expiry(sess);
    if (expires - entry.expires > TOUCH_MS) {
      entry.expires = expires;
      this._save();
    }
    cb?.(null);
  }

  destroy(sid, cb) {
    if (this.sessions[sid]) {
      delete this.sessions[sid];
      this._save();
      this.store.flush();
    }
    cb?.(null);
  }

  length(cb) {
    cb(null, Object.keys(this.sessions).length);
  }

  clear(cb) {
    this.sessions = {};
    this._save();
    cb?.(null);
  }

  all(cb) {
    const out = {};
    for (const [sid, entry] of Object.entries(this.sessions)) {
      try {
        out[sid] = JSON.parse(entry.data);
      } catch { /* entrada corrupta: se ignora */ }
    }
    cb(null, out);
  }
}
