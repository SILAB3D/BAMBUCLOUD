/**
 * Almacen JSON minimo en disco.
 *
 * Guarda lo que tiene que sobrevivir a un reinicio del proceso: historial de
 * actividad, ajustes de avisos, suscripciones de Web Push y la fase del ciclo
 * de la impresion en curso.
 *
 * Las escrituras se agrupan: durante una impresion el historial se toca cada
 * pocos segundos y no tiene sentido pegarle al disco en cada cambio.
 */

import fs from 'node:fs';
import path from 'node:path';

const FLUSH_MS = 800;

export class Store {
  /**
   * @param {string} file ruta del JSON
   * @param {object} defaults valores iniciales si el fichero no existe
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    this._timer = null;

    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...defaults, ...raw };
    } catch {
      // No existe o esta corrupto: arrancamos con los valores por defecto.
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.flushSoon();
  }

  flushSoon() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, FLUSH_MS);
    this._timer.unref?.();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Escritura en dos pasos: un corte de luz a media escritura dejaria el
      // JSON truncado y perderiamos el historial entero al arrancar.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] no se pudo guardar:', err.message);
    }
  }
}
