/**
 * Cliente de Bambu Cloud.
 *
 * Implementa el mismo flujo que usa PrintSphere (github.com/cptkirki/PrintSphere):
 *   1. Login HTTP contra api.bambulab.com -> accessToken (JWT)
 *   2. Manejo de loginType "verifyCode" (codigo por email) y TFA
 *   3. Listado de impresoras vinculadas -> serial, modelo, online
 *   4. MQTT sobre TLS a us.mqtt.bambulab.com:8883 con usuario u_<uid>
 *      y el accessToken como password
 *   5. Suscripcion a device/<serial>/report y publicacion de "pushall"
 *
 * Nota: no es una API publica de Bambu Lab. Puede cambiar sin aviso.
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';

const REGIONS = {
  global: {
    api: 'https://api.bambulab.com',
    mqtt: 'mqtts://us.mqtt.bambulab.com:8883',
  },
  china: {
    api: 'https://api.bambulab.cn',
    mqtt: 'mqtts://cn.mqtt.bambulab.com:8883',
  },
};

const PATHS = {
  login: '/v1/user-service/user/login',
  tfa: '/api/sign-in/tfa',
  emailCode: '/v1/user-service/user/sendemail/code',
  bind: '/v1/iot-service/api/user/bind',
  tasks: '/v1/user-service/my/tasks?limit=10',
};

const PUSH_ALL = JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } });
const GET_VERSION = JSON.stringify({ info: { sequence_id: '0', command: 'get_version' } });

/** Decodifica el payload de un JWT sin verificar la firma. */
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Del JWT sale el usuario MQTT. Bambu usa el campo "username" si existe,
 * y si no "u_" + uid. Es exactamente lo que hace PrintSphere.
 */
export function mqttUsernameFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  if (payload.username) return payload.username;
  if (payload.uid) return `u_${payload.uid}`;
  return null;
}

export class BambuCloud extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.email
   * @param {string} [opts.password]
   * @param {string} [opts.region] 'global' | 'china'
   * @param {string} [opts.accessToken] token ya obtenido (salta el login)
   * @param {string} [opts.serial] serial de la impresora a seguir
   */
  constructor(opts = {}) {
    super();
    this.email = opts.email;
    this.password = opts.password;
    this.region = REGIONS[opts.region || 'global'] ? opts.region || 'global' : 'global';
    this.accessToken = opts.accessToken || null;
    this.serial = opts.serial || null;

    this.client = null;
    this.connected = false;
    this.devices = [];
    /** Estado acumulado de la impresora (los reports son parciales). */
    this.state = {};
    this.lastMessageAt = null;
    this._reconnectTimer = null;
    this._pushallTimer = null;
    this._stopped = false;
  }

  get api() {
    return REGIONS[this.region].api;
  }

  get mqttUrl() {
    return REGIONS[this.region].mqtt;
  }

  // ---------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------

  async _post(path, body, token = null) {
    const res = await fetch(this.api + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'bambucloud-dashboard/1.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* respuesta no-JSON */
    }
    return { status: res.status, json, text };
  }

  async _get(path, token = this.accessToken) {
    const res = await fetch(this.api + path, {
      headers: {
        'User-Agent': 'bambucloud-dashboard/1.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ignorado */
    }
    return { status: res.status, json, text };
  }

  /**
   * Paso 1 del login. Devuelve:
   *   { ok: true, accessToken }            -> login completo
   *   { ok: false, needs: 'emailCode' }    -> Bambu mando un codigo al email
   *   { ok: false, needs: 'tfa', tfaKey }  -> hace falta el codigo 2FA
   *   { ok: false, error }                 -> fallo
   */
  async login() {
    if (!this.email || !this.password) {
      return { ok: false, error: 'Faltan email o password' };
    }

    const { json } = await this._post(PATHS.login, {
      account: this.email,
      password: this.password,
      apiError: '',
    });

    if (!json) return { ok: false, error: 'Respuesta de login invalida' };

    const data = json.data || {};
    const token = json.accessToken || data.accessToken;
    const loginType = json.loginType || data.loginType;
    const tfaKey = json.tfaKey || data.tfaKey;

    if (loginType === 'verifyCode') {
      // Bambu ya envio el codigo al email en esta misma llamada
      return { ok: false, needs: 'emailCode' };
    }

    if (loginType === 'tfa' || tfaKey) {
      this._tfaKey = tfaKey;
      return { ok: false, needs: 'tfa', tfaKey };
    }

    if (token) {
      this._setToken(token);
      return { ok: true, accessToken: token };
    }

    return {
      ok: false,
      error: json.apiError || json.msg || json.error || 'Login rechazado',
    };
  }

  /** Reenvia el codigo de verificacion por email. */
  async requestEmailCode() {
    const { status, json } = await this._post(PATHS.emailCode, {
      email: this.email,
      type: 'codeLogin',
    });
    return { ok: status >= 200 && status < 300, response: json };
  }

  /** Paso 2 con el codigo recibido por email. */
  async loginWithEmailCode(code) {
    const { json } = await this._post(PATHS.login, {
      account: this.email,
      code: String(code).trim(),
    });
    const token = json?.accessToken || json?.data?.accessToken;
    if (token) {
      this._setToken(token);
      return { ok: true, accessToken: token };
    }
    return { ok: false, error: json?.apiError || json?.msg || 'Codigo rechazado' };
  }

  /** Paso 2 con codigo 2FA (TOTP). Este endpoint vive en bambulab.com, no en api. */
  async loginWithTfa(code, tfaKey = this._tfaKey) {
    const base = this.region === 'china' ? 'https://bambulab.cn' : 'https://bambulab.com';
    const res = await fetch(base + PATHS.tfa, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tfaKey, tfaCode: String(code).trim() }),
    });
    // El token llega en la cookie "token"
    const setCookie = res.headers.getSetCookie?.() || [];
    const cookie = setCookie.find((c) => c.startsWith('token='));
    const token = cookie ? decodeURIComponent(cookie.split(';')[0].slice(6)) : null;

    if (token) {
      this._setToken(token);
      return { ok: true, accessToken: token };
    }
    return { ok: false, error: 'La respuesta 2FA no incluyo token' };
  }

  _setToken(token) {
    this.accessToken = token;
    this.mqttUsername = mqttUsernameFromToken(token);
    const payload = decodeJwtPayload(token);
    this.tokenExpiresAt = payload?.exp ? payload.exp * 1000 : null;
    this.emit('token', { token, username: this.mqttUsername, expiresAt: this.tokenExpiresAt });
  }

  /** Impresoras vinculadas a la cuenta. */
  async listDevices() {
    const { json } = await this._get(PATHS.bind);
    const devices = json?.devices || json?.data?.devices || [];
    this.devices = devices.map((d) => ({
      serial: d.dev_id,
      name: d.name,
      model: d.dev_product_name || d.dev_model_name,
      online: Boolean(d.online),
      accessCode: d.dev_access_code,
      nozzleDiameter: d.nozzle_diameter,
    }));
    this.emit('devices', this.devices);
    return this.devices;
  }

  /**
   * Trabajos recientes. De aqui sale la imagen de portada del print actual,
   * que es lo unico "visual" que la nube expone.
   */
  async listTasks() {
    const { json } = await this._get(PATHS.tasks);
    const hits = json?.hits || json?.data?.hits || [];
    return hits.map((t) => ({
      id: t.id,
      title: t.title,
      cover: t.cover,
      status: t.status,
      deviceSerial: t.deviceId,
      startTime: t.startTime,
      endTime: t.endTime,
      weight: t.weight,
      costTime: t.costTime,
    }));
  }

  // ---------------------------------------------------------------------
  // MQTT
  // ---------------------------------------------------------------------

  connect() {
    if (!this.accessToken) throw new Error('Sin accessToken: haz login primero');
    if (!this.serial) throw new Error('Sin serial de impresora');
    if (!this.mqttUsername) this.mqttUsername = mqttUsernameFromToken(this.accessToken);
    if (!this.mqttUsername) throw new Error('No se pudo derivar el usuario MQTT del token');

    this._stopped = false;
    const reportTopic = `device/${this.serial}/report`;
    this.requestTopic = `device/${this.serial}/request`;

    this.client = mqtt.connect(this.mqttUrl, {
      clientId: `bambucloud-dash-${Math.random().toString(16).slice(2, 10)}`,
      username: this.mqttUsername,
      password: this.accessToken,
      protocolVersion: 4, // MQTT 3.1.1, como usa PrintSphere
      keepalive: 30,
      clean: true,
      reconnectPeriod: 15000,
      connectTimeout: 10000,
      rejectUnauthorized: true,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.emit('status', { connected: true, detail: 'Conectado a Bambu Cloud MQTT' });
      this.client.subscribe(reportTopic, { qos: 1 }, (err) => {
        if (err) {
          this.emit('error', new Error(`Fallo al suscribirse a ${reportTopic}: ${err.message}`));
          return;
        }
        this.emit('status', { connected: true, detail: 'Suscrito, pidiendo sincronizacion' });
        this.requestSync();
        // La impresora deja de mandar el estado completo con el tiempo;
        // un pushall periodico mantiene el estado fresco.
        clearInterval(this._pushallTimer);
        this._pushallTimer = setInterval(() => this.publish(PUSH_ALL), 60_000);
      });
    });

    this.client.on('message', (topic, payload) => {
      if (topic !== reportTopic) return;
      let msg;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }
      this.lastMessageAt = Date.now();
      this._mergeReport(msg);
      this.emit('report', msg, this.state);
    });

    this.client.on('error', (err) => {
      this.emit('error', err);
      // Codigo 4/5 = credenciales rechazadas -> el token caduco
      if (/Not authorized|Bad username|bad user name/i.test(err.message || '')) {
        this.emit('auth-expired');
      }
    });

    this.client.on('close', () => {
      if (this.connected) {
        this.connected = false;
        this.emit('status', { connected: false, detail: 'Conexion MQTT cerrada' });
      }
    });

    return this.client;
  }

  publish(payload) {
    if (!this.client || !this.connected) return false;
    this.client.publish(this.requestTopic, payload, { qos: 0 });
    return true;
  }

  requestSync() {
    this.publish(PUSH_ALL);
    this.publish(GET_VERSION);
  }

  /** Los reports son parciales: hay que hacer merge profundo sobre el estado. */
  _mergeReport(msg) {
    for (const [key, value] of Object.entries(msg)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.state[key] = { ...(this.state[key] || {}), ...value };
      } else {
        this.state[key] = value;
      }
    }
  }

  disconnect() {
    this._stopped = true;
    clearInterval(this._pushallTimer);
    clearTimeout(this._reconnectTimer);
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.connected = false;
  }
}

export { REGIONS, PATHS };
