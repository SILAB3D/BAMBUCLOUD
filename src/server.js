/**
 * Servidor del dashboard.
 *
 *   navegador  <--WebSocket-->  este servidor  <--MQTT TLS-->  Bambu Cloud
 *                                     ^
 *                                     |  POST /api/camera (opcional)
 *                               agente local en tu red
 *
 * Corre en un VPS. La impresora nunca tiene que ser accesible desde internet:
 * es ella la que publica en la nube de Bambu, y nosotros solo escuchamos.
 */

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';

import { BambuCloud } from './bambu-cloud.js';
import { normalize } from './normalize.js';
import { Notifier, HISTORY_DAYS, TRIGGERS } from './notifier.js';
import { Store } from './store.js';
import { PushHub } from './push.js';
import { JobCycle } from './job-cycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
// Configurable para poder apuntarlo a un volumen persistente en produccion:
// si el token se pierde en cada reinicio, la cuenta vuelve a pedir codigo.
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, '..', '.bambu-token.json');
// Historial, ajustes, suscripciones push y fase del ciclo. Vive junto al token
// para que un solo volumen montado conserve todo el estado del dashboard.
const STATE_FILE =
  process.env.STATE_FILE || path.join(path.dirname(TOKEN_FILE), 'bambu-state.json');
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const ADMIN_CODE = String(process.env.ADMIN_CODE || '1510');
const COOL_MS = Number(process.env.COOLDOWN_MS || 15 * 60_000);

// ---------------------------------------------------------------------------
// Estado global del proceso
// ---------------------------------------------------------------------------

const store = new Store(STATE_FILE, {
  history: [],
  settings: null,
  pushSubs: [],
  cycle: null,
});

const push = new PushHub({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || `mailto:${process.env.BAMBU_EMAIL || 'admin@localhost'}`,
  store,
});

const notifier = new Notifier({
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  discordWebhook: process.env.DISCORD_WEBHOOK,
  genericWebhook: process.env.GENERIC_WEBHOOK,
  progressStep: Number(process.env.NOTIFY_PROGRESS_STEP || 0),
  store,
  push,
});

const jobCycle = new JobCycle({ coolMs: COOL_MS, store });

const app_state = {
  cloud: null,
  printer: null, // { serial, name, model }
  status: { connected: false, detail: 'Sin iniciar' },
  normalized: null,
  currentTask: null, // portada + titulo desde /my/tasks
  camera: null, // { jpegBase64, at } enviado por el agente local
  loginPending: null, // 'emailCode' | 'tfa' | null
  gotState: false,
};

// ---------------------------------------------------------------------------
// Cache del accessToken en disco
//
// Las cuentas con verificacion por email piden un codigo nuevo en cada login,
// y eso obliga a estar delante del dashboard cada vez que reinicia el proceso.
// Guardar el token vale hasta que caduque (unos meses).
// ---------------------------------------------------------------------------

function loadCachedToken() {
  try {
    const { token, expiresAt } = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!token) return null;
    if (expiresAt && Date.now() > expiresAt - 60_000) {
      console.log('[token] el token en cache ha caducado');
      return null;
    }
    return token;
  } catch {
    return null; // no existe o esta corrupto: login normal
  }
}

function saveToken({ token, expiresAt }) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expiresAt }), { mode: 0o600 });
  } catch (err) {
    console.error('[token] no se pudo guardar:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Broadcast a los navegadores conectados
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function snapshot() {
  return {
    status: app_state.status,
    printer: app_state.printer,
    state: app_state.normalized,
    task: app_state.currentTask,
    camera: app_state.camera ? { at: app_state.camera.at } : null,
    // El panel de actividad muestra 15 dias: se manda el historial completo ya
    // podado, no una ventana de los ultimos 20.
    notifications: notifier.history,
    historyDays: HISTORY_DAYS,
    cycle: jobCycle.toJSON(),
    settings: notifier.settings,
    push: { supported: push.enabled, publicKey: push.publicKey, devices: push.count },
    loginPending: app_state.loginPending,
    connected: Boolean(app_state.cloud?.connected),
    lastMessageAt: app_state.cloud?.lastMessageAt || null,
  };
}

// ---------------------------------------------------------------------------
// Arranque de la conexion con Bambu Cloud
// ---------------------------------------------------------------------------

function wireCloud(cloud) {
  cloud.on('status', (s) => {
    app_state.status = s;
    broadcast('status', s);
  });

  cloud.on('report', (_msg, state) => {
    if (!state.print) return;
    const norm = normalize(state);
    app_state.normalized = norm;
    notifier.update(norm, app_state.printer?.name || 'Bambu Lab A1');
    // El primer report tras arrancar describe el pasado, no una transicion:
    // el ciclo lo absorbe sin generar avisos retroactivos.
    jobCycle.update(norm, !app_state.gotState);
    app_state.gotState = true;
    broadcast('state', norm);
  });

  cloud.on('error', (err) => {
    app_state.status = { connected: false, detail: `Error: ${err.message}` };
    broadcast('status', app_state.status);
    console.error('[cloud]', err.message);
  });

  cloud.on('auth-expired', async () => {
    console.warn('[cloud] token caducado, reintentando login');
    cloud.disconnect();
    fs.rmSync(TOKEN_FILE, { force: true });
    cloud.mqttUsername = null;

    const res = await cloud.login();
    if (res.ok) {
      await cloud.resolveMqttUsername();
      cloud.connect();
      return;
    }
    // Cuenta con verificacion por email o 2FA: el relogin no puede ser
    // automatico. Pedimos el codigo en el dashboard en vez de quedarnos
    // callados y desconectados.
    if (res.needs) {
      app_state.loginPending = res.needs;
      app_state.status = {
        connected: false,
        detail:
          res.needs === 'emailCode'
            ? 'El token caduco. Bambu envio un codigo nuevo a tu email.'
            : 'El token caduco. Introduce tu codigo 2FA.',
      };
    } else {
      app_state.status = { connected: false, detail: `Relogin fallido: ${res.error}` };
    }
    broadcast('status', app_state.status);
  });
}

notifier.on('notification', (event) => broadcast('notification', event));
notifier.on('error', (err) => console.error('[notify]', err.message));

// ---------------------------------------------------------------------------
// Ciclo de la impresion: enfriamiento y retirada
// ---------------------------------------------------------------------------

jobCycle.on('phase', (info) => {
  broadcast('cycle', info);
  armCoolingKeepAlive();
  if (info.silent) return;

  const job = info.jobName || 'la impresión';
  const printerName = app_state.printer?.name || 'Bambu Lab A1';
  const mins = Math.round(jobCycle.coolMs / 60_000);

  if (info.phase === 'cooling') {
    notifier.fire('cooling', `🌡️ Enfriando la cama · ${job}. Lista en ${mins} min.`, {
      printerName,
      job,
      level: 'info',
    });
  } else if (info.phase === 'ready') {
    notifier.fire('ready', `📦 Ya puedes retirar la impresión: ${job}`, {
      printerName,
      job,
      level: 'success',
    });
  }
});

async function startCloud() {
  const cloud = new BambuCloud({
    email: process.env.BAMBU_EMAIL,
    password: process.env.BAMBU_PASSWORD,
    region: process.env.BAMBU_REGION || 'global',
    // El token en cache manda sobre BAMBU_TOKEN: la variable de entorno es
    // solo la semilla inicial. Al reves, un BAMBU_TOKEN caducado ganaria para
    // siempre al token nuevo obtenido desde el dashboard.
    accessToken: loadCachedToken() || process.env.BAMBU_TOKEN || null,
    serial: process.env.PRINTER_SERIAL || null,
  });
  app_state.cloud = cloud;
  wireCloud(cloud);
  cloud.on('token', saveToken);

  if (cloud.accessToken) {
    cloud._setToken(cloud.accessToken);
    try {
      await finishStartup(cloud);
      return;
    } catch (err) {
      if (!err.unauthorized) throw err;
      // El token cacheado ya no sirve: lo tiramos y hacemos login normal.
      console.warn('[cloud] token cacheado rechazado, rehaciendo login');
      fs.rmSync(TOKEN_FILE, { force: true });
      cloud.accessToken = null;
      cloud.mqttUsername = null;
    }
  }

  const res = await cloud.login();
  if (!res.ok) {
    if (res.needs) {
      app_state.loginPending = res.needs;
      app_state.status = {
        connected: false,
        detail:
          res.needs === 'emailCode'
            ? 'Bambu envio un codigo a tu email. Introducelo en el dashboard.'
            : 'Introduce tu codigo 2FA en el dashboard.',
      };
      broadcast('status', app_state.status);
      return;
    }
    app_state.status = { connected: false, detail: res.error };
    console.error('[cloud] login fallido:', res.error);
    return;
  }

  await finishStartup(cloud);
}

let taskTimer = null;

async function finishStartup(cloud) {
  app_state.loginPending = null;

  const devices = await cloud.listDevices();
  if (devices.length === 0) {
    app_state.status = { connected: false, detail: 'La cuenta no tiene impresoras vinculadas' };
    broadcast('status', app_state.status);
    return;
  }

  const chosen = cloud.serial
    ? devices.find((d) => d.serial === cloud.serial) || devices[0]
    : devices[0];
  cloud.serial = chosen.serial;
  app_state.printer = { serial: chosen.serial, name: chosen.name, model: chosen.model };
  broadcast('printer', app_state.printer);

  // Un fallo aqui (token raro, MQTT caido) tiene que verse en el dashboard,
  // no reventar el proceso: esto se llama tambien desde una ruta Express.
  try {
    await cloud.resolveMqttUsername();
    cloud.connect();
  } catch (err) {
    app_state.status = { connected: false, detail: `No se pudo conectar a MQTT: ${err.message}` };
    broadcast('status', app_state.status);
    console.error('[cloud]', err.message);
  }

  refreshTask();
  // finishStartup puede correr mas de una vez (login diferido por codigo):
  // un solo intervalo, no uno por llamada.
  clearInterval(taskTimer);
  taskTimer = setInterval(refreshTask, 60_000);
}

/** La portada del print vive en la API REST, no en MQTT. */
async function refreshTask() {
  const cloud = app_state.cloud;
  if (!cloud?.accessToken) return;
  try {
    const tasks = await cloud.listTasks();
    const mine = tasks.find((t) => t.deviceSerial === cloud.serial) || tasks[0] || null;
    if (mine && mine.id !== app_state.currentTask?.id) {
      app_state.currentTask = mine;
      broadcast('task', mine);
    } else if (mine) {
      app_state.currentTask = mine;
    }
  } catch (err) {
    console.error('[tasks]', err.message);
  }
}

// ---------------------------------------------------------------------------
// Keep-alive
//
// Los planes gratuitos (Render) duermen el servicio tras 15 min sin trafico
// ENTRANTE. Dormido no hay MQTT, asi que no se detecta el fin de la impresion
// ni se envian avisos. Mientras hay un trabajo en curso el servidor se pide a
// si mismo /api/health y con eso cuenta como trafico entrante.
//
// Solo mientras imprime o enfria, a proposito: despierto 24/7 son ~720 h/mes y
// el plan gratuito da 750, sin margen para un despiste.
//
// El enfriamiento necesita su propia cadena de pings porque el aviso de "ya
// puedes retirarla" lo dispara un temporizador nuestro: si el servicio se
// duerme durante esos 15 minutos, el temporizador no corre y el aviso no sale.
// Se pincha cada COOL_KEEPALIVE_MS y, sobre todo, justo cuando el enfriamiento
// termina, que es cuando hay algo que notificar.
// ---------------------------------------------------------------------------

const KEEPALIVE_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || null;
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS || 10 * 60_000);
const COOL_KEEPALIVE_MS = Number(process.env.COOLDOWN_KEEPALIVE_MS || 15 * 60_000);
// PAUSE entra: el trabajo sigue vivo y queremos avisar cuando se reanude.
const ACTIVE_STATES = new Set(['RUNNING', 'PREPARE', 'PAUSE']);

function printJobActive() {
  return ACTIVE_STATES.has(app_state.normalized?.state);
}

/** Hay algo que vigilar: imprimiendo o esperando a que la cama se enfrie. */
function needsWakefulness() {
  return printJobActive() || jobCycle.phase === 'cooling';
}

async function ping(reason) {
  if (!KEEPALIVE_URL) return;
  try {
    const res = await fetch(new URL('/api/health', KEEPALIVE_URL), {
      headers: { 'user-agent': 'bambucloud-keepalive' },
      signal: AbortSignal.timeout(20_000),
    });
    console.log(`[keepalive] ping ${res.status} (${reason})`);
  } catch (err) {
    console.error('[keepalive]', err.message);
  }
}

async function keepAlive() {
  if (!needsWakefulness()) return;
  await ping(jobCycle.phase === 'cooling' ? 'enfriando' : 'imprimiendo');
}

let coolPingTimer = null;

/**
 * Cadena de pings durante el enfriamiento. El ultimo cae exactamente al final
 * del periodo, para que el proceso este despierto en el instante en que la
 * pieza pasa a "lista para retirar".
 */
function armCoolingKeepAlive() {
  clearTimeout(coolPingTimer);
  coolPingTimer = null;
  if (!KEEPALIVE_URL || jobCycle.phase !== 'cooling') return;

  ping('inicio de enfriamiento');

  const schedule = () => {
    if (jobCycle.phase !== 'cooling') return;
    const left = jobCycle.coolingRemainingMs();
    // +1 s de margen: al despertar, el temporizador del ciclo ya habra saltado
    // y la notificacion de "lista" sale con el proceso en pie.
    const wait = Math.min(COOL_KEEPALIVE_MS, left + 1000);
    coolPingTimer = setTimeout(async () => {
      await ping(left <= COOL_KEEPALIVE_MS ? 'fin de enfriamiento' : 'enfriando');
      schedule();
    }, Math.max(1000, wait));
    coolPingTimer.unref?.();
  };
  schedule();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.TRUST_HTTPS !== 'false',
    },
  }),
);

function requireAuth(req, res, next) {
  if (!DASH_PASSWORD) return next(); // sin password configurado = abierto
  if (req.session?.authed) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

app.post('/api/login', (req, res) => {
  if (!DASH_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  const given = String(req.body?.password || '');
  const a = Buffer.from(given.padEnd(64).slice(0, 64));
  const b = Buffer.from(DASH_PASSWORD.padEnd(64).slice(0, 64));
  if (crypto.timingSafeEqual(a, b) && given.length === DASH_PASSWORD.length) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Password incorrecta' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: Boolean(!DASH_PASSWORD || req.session?.authed) });
});

app.get('/api/state', requireAuth, (req, res) => res.json(snapshot()));

app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    res.json(await app_state.cloud.listDevices());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Cambia de impresora sin reiniciar el proceso. */
app.post('/api/printer', requireAuth, async (req, res) => {
  const serial = String(req.body?.serial || '');
  const cloud = app_state.cloud;
  if (!cloud) return res.status(400).json({ error: 'Cloud no iniciado' });
  const device = cloud.devices.find((d) => d.serial === serial);
  if (!device) return res.status(404).json({ error: 'Impresora no encontrada' });
  cloud.disconnect();
  cloud.serial = serial;
  cloud.state = {};
  app_state.printer = { serial, name: device.name, model: device.model };
  app_state.normalized = null;
  try {
    cloud.connect();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  broadcast('printer', app_state.printer);
  res.json({ ok: true });
});

/** Completa el login cuando Bambu pidio codigo de email o 2FA. */
app.post('/api/login-code', requireAuth, async (req, res) => {
  const cloud = app_state.cloud;
  const code = String(req.body?.code || '');
  if (!cloud || !app_state.loginPending) {
    return res.status(400).json({ error: 'No hay un login pendiente' });
  }
  const result =
    app_state.loginPending === 'tfa'
      ? await cloud.loginWithTfa(code)
      : await cloud.loginWithEmailCode(code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  try {
    await finishStartup(cloud);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  res.json({ ok: true });
});

app.post('/api/resync', requireAuth, (req, res) => {
  app_state.cloud?.requestSync();
  refreshTask();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ciclo de impresion
// ---------------------------------------------------------------------------

app.get('/api/cycle', requireAuth, (req, res) => res.json(jobCycle.toJSON()));

/** "Ya la he retirado": cierra el ciclo y devuelve el panel a reposo. */
app.post('/api/cycle/collected', requireAuth, (req, res) => {
  jobCycle.clear();
  res.json({ ok: true, cycle: jobCycle.toJSON() });
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

app.get('/api/push/key', requireAuth, (req, res) => {
  res.json({ supported: push.enabled, publicKey: push.publicKey, devices: push.count });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  if (!push.enabled) return res.status(503).json({ error: 'Web Push no configurado' });
  const result = push.subscribe(req.body?.subscription || req.body);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  res.json(push.unsubscribe(String(req.body?.endpoint || '')));
});

/** Comprobacion desde el panel: manda un aviso real a este dispositivo. */
app.post('/api/push/test', requireAuth, requireAdmin, async (req, res) => {
  if (!push.enabled) {
    return res.status(503).json({
      error: 'El servidor no tiene claves VAPID configuradas (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)',
    });
  }
  const result = await push.send({
    title: app_state.printer?.name || 'Bambu Lab',
    body: '🔔 Prueba de notificaciones. Si lees esto, funciona.',
    tag: 'test',
    url: '/',
  });
  console.log(`[push] prueba enviada a ${result.sent} dispositivo(s)`);
  res.json({ ok: true, devices: push.count, ...result });
});

// ---------------------------------------------------------------------------
// Administracion
//
// El codigo es una barrera de conveniencia sobre una sesion ya autenticada,
// no un segundo factor: evita tocar por accidente los ajustes desde un movil
// desbloqueado, nada mas.
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  return res.status(403).json({ error: 'Panel de administración bloqueado' });
}

function sameCode(given) {
  const a = Buffer.from(String(given).padEnd(32).slice(0, 32));
  const b = Buffer.from(ADMIN_CODE.padEnd(32).slice(0, 32));
  return crypto.timingSafeEqual(a, b) && String(given).length === ADMIN_CODE.length;
}

app.post('/api/admin/unlock', requireAuth, (req, res) => {
  if (!sameCode(req.body?.code || '')) {
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/admin/lock', requireAuth, (req, res) => {
  if (req.session) req.session.admin = false;
  res.json({ ok: true });
});

app.get('/api/admin/status', requireAuth, (req, res) => {
  res.json({ unlocked: Boolean(req.session?.admin) });
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    settings: notifier.settings,
    // El cliente dibuja un interruptor por entrada: la lista manda.
    triggers: TRIGGERS,
    progressStep: notifier.progressStep,
    push: { supported: push.enabled, publicKey: push.publicKey, devices: push.count },
    channels: {
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      discord: Boolean(process.env.DISCORD_WEBHOOK),
      webhook: Boolean(process.env.GENERIC_WEBHOOK),
    },
    account: process.env.BAMBU_EMAIL || null,
  });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const settings = notifier.updateSettings(req.body || {});
  broadcast('settings', settings);
  res.json({ ok: true, settings });
});

/**
 * Cierra la sesion de Bambu Cloud: corta el MQTT y borra el token cacheado.
 * El proximo arranque (o el boton de sincronizar) volvera a pedir el codigo de
 * verificacion por email, que es como Bambu protege esta cuenta.
 */
app.post('/api/admin/bambu-logout', requireAuth, requireAdmin, (req, res) => {
  app_state.cloud?.disconnect();
  if (app_state.cloud) {
    app_state.cloud.accessToken = null;
    app_state.cloud.mqttUsername = null;
  }
  fs.rmSync(TOKEN_FILE, { force: true });
  clearInterval(taskTimer);

  app_state.normalized = null;
  app_state.currentTask = null;
  app_state.gotState = false;
  app_state.loginPending = null;
  app_state.status = {
    connected: false,
    detail: 'Sesión de Bambu Lab cerrada. Vuelve a iniciar sesión para reconectar.',
  };
  broadcast('status', app_state.status);
  broadcast('bambu-logout', { at: Date.now() });
  res.json({ ok: true });
});

/** Rehace el login de Bambu tras un cierre de sesion, sin reiniciar el proceso. */
app.post('/api/admin/bambu-login', requireAuth, requireAdmin, async (req, res) => {
  try {
    await startCloud();
    res.json({ ok: true, loginPending: app_state.loginPending });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Camara: el agente local sube snapshots aqui ---

app.post('/api/camera', (req, res) => {
  if (AGENT_TOKEN && req.get('x-agent-token') !== AGENT_TOKEN) {
    return res.status(401).json({ error: 'Token de agente invalido' });
  }
  const jpegBase64 = req.body?.image;
  if (typeof jpegBase64 !== 'string' || jpegBase64.length < 100) {
    return res.status(400).json({ error: 'Imagen ausente o invalida' });
  }
  app_state.camera = { jpegBase64, at: Date.now() };
  broadcast('camera', { at: app_state.camera.at });
  res.json({ ok: true });
});

app.get('/api/camera.jpg', requireAuth, (req, res) => {
  if (!app_state.camera) return res.status(404).end();
  const buf = Buffer.from(app_state.camera.jpegBase64, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(buf);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudConnected: Boolean(app_state.cloud?.connected),
    lastMessageAt: app_state.cloud?.lastMessageAt || null,
    cameraAgeMs: app_state.camera ? Date.now() - app_state.camera.at : null,
    uptimeSec: Math.round(process.uptime()),
    jobActive: printJobActive(),
    phase: jobCycle.phase,
    coolingRemainingMs: jobCycle.coolingRemainingMs(),
    keepAlive: Boolean(KEEPALIVE_URL),
    awake: needsWakefulness(),
    pushDevices: push.count,
  });
});

app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
      // El Service Worker se revalida siempre: si el navegador se queda con
      // una copia vieja, la PWA sigue sirviendo la interfaz anterior durante
      // dias y los despliegues parecen no aplicarse.
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.set('Cache-Control', 'no-cache');
      }
    },
  }),
);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot() }));
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 30_000);
  ws.on('close', () => clearInterval(ping));
});

server.listen(PORT, () => {
  console.log(`Dashboard escuchando en http://localhost:${PORT}`);
  console.log(`[store] estado en ${STATE_FILE} (${notifier.history.length} eventos)`);
  if (push.enabled) console.log(`[push] activo, ${push.count} dispositivo(s) suscrito(s)`);
  if (KEEPALIVE_URL) {
    console.log(
      `[keepalive] activo cada ${Math.round(KEEPALIVE_MS / 60000)} min mientras imprime, ` +
        `y cada ${Math.round(COOL_KEEPALIVE_MS / 60000)} min mientras enfria`,
    );
    setInterval(keepAlive, KEEPALIVE_MS);
    // El proceso pudo caerse a mitad del enfriamiento: retomamos la cadena.
    armCoolingKeepAlive();
  }
  startCloud().catch((err) => console.error('[startup]', err));
});

// Red de seguridad: este proceso vive semanas en un VPS. Un rechazo suelto
// (la nube de Bambu cortando una peticion, por ejemplo) no puede tirar abajo
// el dashboard entero.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});

process.on('SIGTERM', () => {
  app_state.cloud?.disconnect();
  store.flush(); // el historial pendiente no puede perderse en un redeploy
  server.close(() => process.exit(0));
});
